import { createRequire } from "node:module";
import {
  AnchorSchema,
  BoxSchema,
  InjectionPacketSchema,
  SummarySchema,
  TurnSchema,
  type Anchor,
  type Box,
  type InjectionPacket,
  type Summary,
  type Turn
} from "../domain/types.js";
import type { MemoryStore } from "./memory-store.js";

interface PayloadRow {
  payload: string;
}

interface DatabaseSyncConstructor {
  new (location: string): DatabaseSync;
}

interface DatabaseSync {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): StatementSync;
}

interface StatementSync {
  all(...anonymousParameters: unknown[]): unknown[];
  run(...anonymousParameters: unknown[]): void;
}

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: DatabaseSyncConstructor;
};

export class SqliteStore implements MemoryStore {
  private readonly database: DatabaseSync;

  constructor(location: string) {
    this.database = new DatabaseSync(location);
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  async saveTurn(turn: Turn): Promise<void> {
    const parsed = TurnSchema.parse(turn);
    this.database
      .prepare(
        `insert into turns (id, thread_id, sequence, payload)
         values (?, ?, ?, ?)
         on conflict(id) do update set
           thread_id = excluded.thread_id,
           sequence = excluded.sequence,
           payload = excluded.payload`
      )
      .run(parsed.id, parsed.threadId, parsed.sequence, JSON.stringify(parsed));
  }

  async listTurns(threadId: string): Promise<Turn[]> {
    const rows = this.database
      .prepare("select payload from turns where thread_id = ? order by sequence asc, id asc")
      .all(threadId) as PayloadRow[];

    return rows.map((row) => TurnSchema.parse(JSON.parse(row.payload)));
  }

  async saveSummary(summary: Summary): Promise<void> {
    this.upsertPayload("summaries", SummarySchema.parse(summary));
  }

  async listSummaries(): Promise<Summary[]> {
    return this.listPayloads("summaries", SummarySchema);
  }

  async saveBox(box: Box): Promise<void> {
    this.upsertPayload("boxes", BoxSchema.parse(box));
  }

  async listBoxes(): Promise<Box[]> {
    return this.listPayloads("boxes", BoxSchema);
  }

  async saveAnchor(anchor: Anchor): Promise<void> {
    this.upsertPayload("anchors", AnchorSchema.parse(anchor));
  }

  async listAnchors(): Promise<Anchor[]> {
    return this.listPayloads("anchors", AnchorSchema);
  }

  async saveInjection(packet: InjectionPacket): Promise<void> {
    const parsed = InjectionPacketSchema.parse(packet);
    this.database
      .prepare(
        `insert into injections (id, host_session_id, payload)
         values (?, ?, ?)
         on conflict(id) do update set
           host_session_id = excluded.host_session_id,
           payload = excluded.payload`
      )
      .run(parsed.id, parsed.hostSessionId, JSON.stringify(parsed));
  }

  async listInjections(hostSessionId: string): Promise<InjectionPacket[]> {
    const rows = this.database
      .prepare("select payload from injections where host_session_id = ? order by id asc")
      .all(hostSessionId) as PayloadRow[];

    return rows.map((row) => InjectionPacketSchema.parse(JSON.parse(row.payload)));
  }

  private migrate(): void {
    this.database.exec(`
      create table if not exists turns (
        id text primary key,
        thread_id text not null,
        sequence integer not null,
        payload text not null
      );

      create index if not exists idx_turns_thread_sequence
        on turns (thread_id, sequence);

      create table if not exists summaries (
        id text primary key,
        payload text not null
      );

      create table if not exists boxes (
        id text primary key,
        payload text not null
      );

      create table if not exists anchors (
        id text primary key,
        payload text not null
      );

      create table if not exists injections (
        id text primary key,
        host_session_id text not null,
        payload text not null
      );

      create index if not exists idx_injections_host_session
        on injections (host_session_id);
    `);
  }

  private upsertPayload(tableName: "summaries" | "boxes" | "anchors", item: { id: string }): void {
    this.database
      .prepare(
        `insert into ${tableName} (id, payload)
         values (?, ?)
         on conflict(id) do update set payload = excluded.payload`
      )
      .run(item.id, JSON.stringify(item));
  }

  private listPayloads<T>(
    tableName: "summaries" | "boxes" | "anchors",
    schema: { parse(value: unknown): T }
  ): T[] {
    const rows = this.database
      .prepare(`select payload from ${tableName} order by id asc`)
      .all() as PayloadRow[];

    return rows.map((row) => schema.parse(JSON.parse(row.payload)));
  }
}

"""A refused new admission must not block durable continuations."""
from contextlib import nullcontext
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('wake_consumer', Path(__file__).resolve().parents[1] / 'factory/consumer.py')
consumer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(consumer)


class WakeAfterRefusal(unittest.TestCase):
    def test_binding_and_dispatch_refusals_still_wake(self):
        for refused in ('runtime_binding_options', 'dispatch_bound_trigger'):
            with self.subTest(refused=refused), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                (root / consumer.TRIGGER).parent.mkdir(parents=True, exist_ok=True)
                (root / consumer.TRIGGER).write_text('{}')
                with patch.multiple(consumer, read_settings=lambda _: {}, verify_source=lambda _: root,
                        shared_root=lambda _: root, cli=lambda *_: ['native'], archon_home=lambda: root,
                        verify_registry_environment=lambda _: None, windowless=lambda: False,
                        single_flight=lambda _: nullcontext(True), launch_decision=lambda *_: True,
                        wake_allowed=lambda *_: True), \
                        patch.object(consumer, 'runtime_binding_options', return_value={'helper': 'fixture'}) as options, \
                        patch.object(consumer, 'dispatch_bound_trigger', return_value=0) as dispatch, \
                        patch.object(consumer, 'execute', return_value=subprocess.CompletedProcess([], 0)) as execute:
                    (options if refused == 'runtime_binding_options' else dispatch).side_effect = ValueError('synthetic refusal')
                    self.assertEqual(consumer.schedule(root, ['fire']), 1)
                    self.assertEqual(execute.call_count, 1)
                    self.assertEqual(execute.call_args.args[0], ['native', 'workflow', 'wake'])


if __name__ == '__main__':
    unittest.main()

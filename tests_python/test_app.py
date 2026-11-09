import unittest
from pathlib import Path

from streamlit.testing.v1 import AppTest


class StreamlitSmokeTests(unittest.TestCase):
    def test_disconnected_app_renders_without_exceptions(self) -> None:
        app = AppTest.from_file(str(Path(__file__).resolve().parents[1] / "streamlit_app.py"))
        app.run(timeout=10)
        self.assertFalse(app.exception)
        self.assertEqual(app.title[0].value, "Fantasy GM")
        self.assertTrue(any(item.label == "Sleeper username" for item in app.text_input))


if __name__ == "__main__":
    unittest.main()

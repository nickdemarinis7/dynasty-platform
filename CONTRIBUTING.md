# Contributing to Fantasy GM

Fantasy GM is a Python 3.13 and Streamlit application. Production code lives
in `streamlit_app.py` and `python_app/`; regression coverage lives in
`tests_python/`.

## Local setup

1. Create and activate a virtual environment.
2. Run `pip install -r requirements.txt`.
3. Start the app with `streamlit run streamlit_app.py`.

## Development guidelines

- Keep provider access in `python_app/providers.py` and give every network call
  a timeout, graceful failure state, and an appropriate cache policy.
- Put league analysis in `python_app/analytics.py`; recommendation construction
  and safety policy belong in `python_app/recommendations.py`.
- Treat missing evidence as unknown, never as a zero or positive signal.
- Preserve market, roster-safety, partner-fit, and availability gates when
  adding new trade strategies.
- Keep Streamlit session keys stable and test navigation changes.
- Add focused regression coverage for every bug fix.

## Validation

Before opening a pull request, run:

```bash
python -m unittest discover -s tests_python
python -m tests_python.recommendation_audit
python -m compileall -q python_app streamlit_app.py
pip check
```

Also test light and dark modes at desktop and mobile widths when changing UI.

## Pull requests

Describe the user-visible outcome, important model tradeoffs, validation run,
and any data-source or cache changes. Include screenshots for UI work and sample
recommendation output for engine changes.

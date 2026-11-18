# Platform strategy: Streamlit product, one recommendation engine

## Decision

Fantasy GM's production application is the Python/Streamlit app rooted at
`streamlit_app.py`. Its models, projections, and recommendation logic in
`python_app/` are the canonical product implementation.

Historical alternative frontend code is not retained in the production
repository. Any future client must use a defined API contract rather than
duplicating the recommendation engine.

## Why this is the durable default

- One deployable application and one engine avoid recommendation drift.
- The Python engine supports the simulation, calibration, and optimization work
  that now defines the product.
- Streamlit provides the current mobile-oriented UI, OIDC integration, caching,
  and Community Cloud deployment path.
- Deterministic engine tests and recommendation audits exercise the shipped code.

## When to introduce another web client

Move beyond Streamlit only when measured product needs justify the additional
client/API boundary, such as:

- interaction or accessibility requirements that Streamlit cannot meet;
- authenticated multi-user workflows requiring a dedicated API;
- background jobs or centralized historical computation;
- measured traffic or latency that requires independently scaling the engine.

## Migration path

1. Define versioned request and response schemas around the Python engine.
2. Preserve the existing Python test fixtures as contract tests.
3. Expose only the required operations through an authenticated API.
4. Build a new client against those contracts without duplicating engine logic.
5. Cut over only after accessibility, mobile, performance, and recommendation
   parity are demonstrated.

## Hosting

- Production application: Streamlit Community Cloud
- Optional durable storage: Supabase, available only with OIDC authentication

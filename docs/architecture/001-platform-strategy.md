# Platform strategy: mobile web first, Python when justified

## Decision

Fantasy GM will remain a mobile-first Next.js application deployed on Vercel.
Analytical operations used by the UI are exposed through `src/lib/analytics`.
The algorithms remain in TypeScript until a workload clearly benefits from a
separate Python service.

We will not rewrite the application in Streamlit. Streamlit is useful for
internal analysis and prototypes, but it does not offer the UI control required
for the product's iPhone-first navigation and interaction model.

## Why this is the durable default

- One deployable application is simpler to operate and debug.
- Local calculations avoid network latency and service availability failures.
- Existing domain logic has deterministic automated tests.
- Next.js provides the installable, responsive interface the product needs.
- The analytics facade prevents screens from coupling to engine file layout.

## When to introduce Python

Create a FastAPI service only when at least one of these is true:

- optimization requires OR-Tools or another Python-native solver;
- projections use pandas, NumPy, scikit-learn, or trained model artifacts;
- calculations exceed practical browser/serverless execution limits;
- shared scheduled data processing or centralized persisted results are needed.

## Migration path

1. Define versioned JSON request and response schemas for one operation.
2. Add parity fixtures that both TypeScript and Python must pass.
3. Port one expensive operation, starting with lineup/package optimization.
4. Call it server-side through a timeout-protected adapter with validation.
5. Retain the TypeScript implementation as a fallback until parity and
   production reliability are established.
6. Port additional operations only when their measured benefit exceeds the
   operational cost of another service.

## Hosting

- Web application: Vercel
- Optional future Python analytics service: a container host such as Render,
  Railway, Fly.io, or a managed cloud container platform
- Streamlit: reserved for internal dashboards or model-development tools

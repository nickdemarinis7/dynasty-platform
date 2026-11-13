# Fantasy GM privacy and data handling

Fantasy GM imports public fantasy-league information from Sleeper and market or
projection evidence from the providers identified in the application. League
data is used to produce roster analysis and is cached temporarily to improve
performance.

Without cloud credentials, league and decision data remains in the active
Streamlit session. When OIDC and Supabase are configured, the app stores saved
trade and decision-journal records under the authenticated provider subject.
The server-side service-role credential is never sent to the browser.

Operational logs contain event names, timings, counts, provider host names, and
error types. They do not intentionally contain usernames, email addresses,
league identifiers, player names, or trade packages.

Users can export league-specific journal data as CSV and can delete all saved
trade and journal records from **Moves → Journal → Privacy and data controls**.
Cached league data expires or is cleared when the user switches leagues.

Deployers are responsible for documenting their chosen identity provider,
hosting region, retention period, support contact, and any provider-specific
terms before offering the application publicly. This document is an engineering
description and should be reviewed for the laws that apply to the deployment.

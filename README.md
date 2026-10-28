# Dynasty Trade Analyzer

A mobile-first fantasy football management platform for dynasty and redraft Sleeper leagues. Get trade recommendations, player projections, and roster analytics from an installable web app.

## ✨ Features

### 🔄 Trade Simulator
- Current FantasyCalc market comparison
- Lineup impact from weekly projections or scored season averages
- Two-sided roster and timeline fit heuristic
- Draft-pick integration when provider values are available

### 🎯 Trade Finder
- Rules-based, quality-gated trade candidates
- League-relative positional need analysis
- Window alignment (Rebuild/Compete/Win Now)
- Player, player-plus-pick, and consolidation packages

### 📊 Power Rankings
- One shared power model across the dashboard and rankings
- Starting strength, depth, and dynasty-capital inputs
- Weekly projection integration when available
- Average-age and competitive-window context

### 🧠 Market Signals
- Position-relative model and market percentiles
- Trajectory curve analysis (Rising/Peak/Declining)
- Production and opportunity scoring
- Explicit low-confidence states when evidence is incomplete
- Model-disagreement signals, not standalone trade advice

### 💎 Player Values
- Current FantasyCalc market values
- League-format inputs for dynasty/redraft, QB count, team count, and PPR
- Search and position filtering

### 📈 Saved Trades
- User-scoped saved evaluations when durable storage is configured
- Session storage fallback
- CSV export

## 🚀 Quick Start

### Streamlit application

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
streamlit run streamlit_app.py
```

Open [http://localhost:8501](http://localhost:8501). The Python app includes live Sleeper league import, FantasyCalc market and pick values, traded-pick ownership, source-health reporting, scored weekly and season production data, optimized lineups, a contextual Trade Simulator, recommendation-to-simulator handoff, saved-trade export, a quality-gated Trade Finder, a live-draft board, market signals, rosters, power rankings, and player values. Recommendation calibration and historical validation remain active development milestones.

### Legacy Next.js application

### Prerequisites
- Node.js 18+ 
- npm or yarn

### Installation

```bash
# Clone the repository
git clone <your-repo-url>
cd windsurf-project-2

# Install dependencies
npm install

# Run development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to view the app.

### Import Your League

1. Click "Import League" in the navigation
2. Enter your Sleeper username
3. Select your league from the list
4. Wait for data to load (players, values, rosters)
5. Start analyzing trades!

## 🏗️ Tech Stack

- **Primary app:** Python 3.13 + Streamlit
- **HTTP/data:** Requests + public Sleeper and FantasyCalc APIs
- **Optional persistence:** Supabase with OIDC authentication
- **Legacy reference implementation:** Next.js, TypeScript, Tailwind, Zustand
- **APIs:** 
  - Sleeper API (league data)
  - FantasyCalc API (dynasty values)
  - Sleeper Projections API (weekly projections)

## 📁 Project Structure

```
src/
├── app/                    # Next.js app router pages
│   ├── league/            # League import
│   ├── rosters/           # Roster management
│   ├── rankings/          # Power rankings
│   ├── values/            # Player values
│   ├── trade/             # Trade simulator & history
│   ├── recommendations/   # Trade finder
│   └── projections/       # Edge intelligence
├── components/            # React components
│   └── ui/               # shadcn/ui components
├── lib/                   # Core logic
│   ├── sleeper-api.ts    # Sleeper API wrapper
│   ├── fantasycalc.ts    # FantasyCalc integration
│   ├── trade-engine.ts   # Trade evaluation
│   ├── projections.ts    # Player projections
│   └── lineup-optimizer.ts # Lineup optimization
└── store/                 # Zustand state management

docs/
├── archive/              # Development notes
└── development/          # Test scripts
```

## 🎮 Usage

### Analyzing a Trade
1. Go to **Trade Simulator**
2. Select two teams
3. Add players/picks to each side
4. View market fairness, partner fit, evidence quality, and lineup impact
5. Save the trade to history

### Finding Trade Opportunities
1. Go to **Trade Finder**
2. Review rules-based recommendations
3. Filter by target position
4. Click "View in Simulator" to analyze

### Checking Player Values
1. Go to **Player Values**
2. Search by player or NFL team and filter by position
3. Compare current market values

## 🔧 Configuration

### League Settings
The app automatically detects your league settings:
- Superflex (QB scoring boost)
- TE Premium (TE scoring boost)
- PPR/Half-PPR/Standard
- Roster slots

### Data Storage

Without cloud credentials, imported league data and decision-journal entries remain in the Streamlit session and can be exported as CSV. Production deployments can enable native OIDC authentication and user-scoped Supabase history. The journal preserves model inputs, predictions, outcomes, and feedback for trade and waiver calibration. The application automatically selects durable storage when those secrets are present.

## 🚢 Deployment

### Deploy to Streamlit Community Cloud

1. Push this repository to GitHub.
2. In Streamlit Community Cloud, create an app from the repository.
3. Set the main file path to `streamlit_app.py`.
4. Deploy. Public Sleeper and FantasyCalc data do not require secrets.

```bash
# Local production-equivalent check
streamlit run streamlit_app.py
```

Each push to the selected branch will redeploy the Streamlit app.

### Optional production accounts and storage

1. Create an OIDC application with Google, Microsoft, Auth0, or another compatible provider. Its callback URL is `<your-app-url>/oauth2callback`.
2. Create a Supabase project and execute [supabase.sql](docs/deployment/supabase.sql).
3. Copy `.streamlit/secrets.example.toml` to `.streamlit/secrets.toml` for local development and replace every placeholder.
4. In Streamlit Community Cloud, paste the same settings into the app's **Secrets** configuration, changing `redirect_uri` to the deployed callback URL.

`service_role_key` is a server-only credential. Never commit it, place it in browser code, or substitute it with a public example value. The real `secrets.toml` is ignored by Git.

### Install on iPhone

1. Open the deployed site in Safari.
2. Tap **Share**.
3. Choose **Add to Home Screen**.
4. Launch **Fantasy GM** from the new home-screen icon.

The Streamlit layout is mobile-first and can be saved as a Safari home-screen shortcut. Streamlit does not currently provide the same full PWA shell as the legacy Next.js version, so it will still behave as a hosted web application.

## 📝 License

MIT

## 🤝 Contributing

Contributions welcome! Please open an issue or PR.

## 📧 Support

For issues or questions, please open a GitHub issue.

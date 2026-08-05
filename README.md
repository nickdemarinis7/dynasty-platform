# Dynasty Trade Analyzer

A comprehensive fantasy football dynasty trade analysis platform built for Sleeper leagues. Get AI-powered trade recommendations, advanced player projections, and deep roster analytics.

## ✨ Features

### 🔄 Trade Simulator
- Real-time trade fairness analysis
- Lineup impact calculations
- Acceptance likelihood predictions
- Draft pick value integration

### 🎯 Trade Finder
- AI-powered trade recommendations
- Positional need analysis
- Window alignment (Rebuild/Compete/Win Now)
- Historical pattern matching

### 📊 Power Rankings
- Team value rankings with composition breakdowns
- Starter vs depth value analysis
- Weekly projection integration
- Average age tracking

### 🧠 Edge Intelligence
- Proprietary player projections
- Trajectory curve analysis (Rising/Peak/Declining)
- Production efficiency scoring
- Team fit analysis
- Buy/Sell/Hold recommendations

### 💎 Player Values
- FantasyCalc dynasty values (1M+ trades)
- League-specific tuning (SF, TEP, PPR)
- Advanced filtering and sorting
- Position rankings and tiers
- Weekly projections integration

### 📈 Trade History
- Win/Loss/Fair trade tracking
- Best and worst trade highlights
- Team trading susceptibilities
- Historical pattern analysis

## 🚀 Quick Start

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

- **Framework:** Next.js 15 (App Router)
- **Language:** TypeScript
- **Styling:** Tailwind CSS v4
- **UI Components:** shadcn/ui (base-ui)
- **State Management:** Zustand
- **Data Persistence:** localStorage
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
4. View fairness score, acceptance likelihood, and lineup impact
5. Save the trade to history

### Finding Trade Opportunities
1. Go to **Trade Finder**
2. Review AI-generated recommendations
3. Filter by position or trade type
4. Click "View in Simulator" to analyze
5. Provide feedback (👍/👎) to improve suggestions

### Checking Player Values
1. Go to **Player Values**
2. Filter by position, team, or tier
3. Sort by value, projection, or position rank
4. View weekly projections and injury status

## 🔧 Configuration

### League Settings
The app automatically detects your league settings:
- Superflex (QB scoring boost)
- TE Premium (TE scoring boost)
- PPR/Half-PPR/Standard
- Roster slots

### Data Storage
All data is stored locally in your browser:
- No backend database required
- Data persists between sessions
- Each user has independent data

## 🚢 Deployment

### Deploy to Vercel (Recommended)

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
vercel
```

Or connect your GitHub repo to Vercel for automatic deployments.

### Deploy to Netlify

```bash
# Install Netlify CLI
npm i -g netlify-cli

# Deploy
netlify deploy --prod
```

## 📝 License

MIT

## 🤝 Contributing

Contributions welcome! Please open an issue or PR.

## 📧 Support

For issues or questions, please open a GitHub issue.

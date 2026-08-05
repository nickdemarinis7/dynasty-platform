# Contributing to Dynasty Trade Analyzer

Thank you for your interest in contributing! This document provides guidelines and information for contributors.

## 🚀 Getting Started

1. Fork the repository
2. Clone your fork: `git clone <your-fork-url>`
3. Create a branch: `git checkout -b feature/your-feature-name`
4. Make your changes
5. Test thoroughly
6. Commit: `git commit -m "Add: your feature description"`
7. Push: `git push origin feature/your-feature-name`
8. Open a Pull Request

## 📁 Project Structure

```
src/
├── app/                    # Next.js pages (App Router)
├── components/            # React components
│   └── ui/               # shadcn/ui components
├── lib/                   # Core business logic
├── store/                 # Zustand state management
└── types/                 # TypeScript type definitions
```

## 🛠️ Development Guidelines

### Code Style
- Use TypeScript for all new code
- Follow existing code formatting (Prettier/ESLint)
- Use meaningful variable and function names
- Add comments for complex logic

### Component Guidelines
- Use functional components with hooks
- Keep components small and focused
- Extract reusable logic into custom hooks
- Use TypeScript interfaces for props

### State Management
- Use Zustand store for global state (`src/store/index.ts`)
- Use React hooks for local component state
- Persist important data to localStorage

### API Integration
- All API calls should be in `src/lib/` files
- Handle errors gracefully
- Add loading states
- Cache responses when appropriate

## 🧪 Testing

Before submitting a PR:
1. Test all affected features manually
2. Verify no TypeScript errors: `npm run build`
3. Check for console errors
4. Test on different screen sizes

## 📝 Commit Messages

Use clear, descriptive commit messages:
- `Add: new feature description`
- `Fix: bug description`
- `Update: what was updated`
- `Refactor: what was refactored`
- `Docs: documentation changes`

## 🐛 Bug Reports

When reporting bugs, include:
- Steps to reproduce
- Expected behavior
- Actual behavior
- Browser/OS information
- Screenshots if applicable

## 💡 Feature Requests

For feature requests:
- Describe the feature clearly
- Explain the use case
- Provide examples if possible
- Consider implementation complexity

## 🔍 Code Review Process

All PRs will be reviewed for:
- Code quality and style
- Functionality
- Performance impact
- TypeScript type safety
- User experience

## 📚 Resources

- [Next.js Documentation](https://nextjs.org/docs)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
- [Tailwind CSS](https://tailwindcss.com/docs)
- [Zustand](https://github.com/pmndrs/zustand)

## ❓ Questions?

Open an issue for questions or discussions!

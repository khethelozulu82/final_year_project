# Contributing Guidelines

This document sets out how our team works in this repo. Read it before your first commit.

## Branching Strategy

- `main` — always working/deployable. Protected. No direct pushes.
- `develop` — integration branch. Features merge here first.
- `feature/<short-description>` — one branch per task, e.g. `feature/login-page`, `feature/sarima-model`
- `fix/<short-description>` — for bug fixes, e.g. `fix/date-parsing-bug`

**Workflow:**
1. Pull latest `develop`: `git checkout develop && git pull`
2. Create your branch: `git checkout -b feature/your-task`
3. Commit your work in small, logical chunks
4. Push and open a Pull Request into `develop`
5. Get at least 1 teammate's review/approval before merging
6. Delete the branch after merging

## Commit Message Convention

Here are a few examples below: 
```
feat: add login page UI
fix: correct date parsing in forecast module
docs: update README setup instructions
test: add unit tests for data cleaning script
refactor: simplify SARIMA pipeline function
chore: update dependencies
```

Keep commits small and focused, one logical change per commit. Avoid single giant "final commit" dumps before deadlines; your commit history is part of how individual contribution is assessed. This also helps better track changes more efficiently.

## Pull Requests

- Every PR should link to an issue: `Closes #12`
- Fill out the PR template (what changed, how to test it)
- No PR merges into `develop` or `main` without at least one review
- Keep PRs small and reviewable, [please please please] avoid 1000-line PRs where possible. Ngizokushaya.

## Issues & Task Tracking

- Every task/feature/bug gets a GitHub Issue before work starts
- Assign yourself to the issue you're working on
- Use labels: `feature`, `bug`, `docs`, `research`, `urgent`
- Move issues across the Project board columns: `Backlog → In Progress → In Review → Done`

## Meetings & Communication

- Log meeting minutes in `/docs/meetings/`
- Weekly check-in: [ Regularly on Tuesdays and Wednesdays ]

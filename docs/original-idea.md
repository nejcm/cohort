# Synthetic Customer Lab

**Concept:** AI-driven synthetic customers attempt real tasks in a sandboxed product, exposing friction in onboarding, checkout, and other workflows. Users inspect browser sessions, outcomes, and evidence rather than only reading generated feedback.

**Competitive landscape:**
- [Uxia](https://www.uxia.app) — AI personas for prototype/interface usability feedback.
- [Synthetic Users](https://docs.syntheticusers.io) — AI personas interacting with real browser sessions, screenshots, transcripts, and friction reports; especially close to the original idea.
- [Maze](https://maze.co) — Established user research and usability testing workflows.
- [Browserbase / Stagehand](https://www.browserbase.com) — Browser-agent infrastructure, not the same end-user product.

**Assessment:** High and growing competition. The original five-persona/browser-recording/friction-report MVP overlaps heavily with existing offerings. Narrow differentiation is essential.

**Original MVP concept:** Five predefined personas; browser task execution; recordings/screenshots; task-completion scoring; friction reports. Target SaaS onboarding.

**Better differentiated directions:**

## A. AI UX Regression Testing (preferred)
Agents rerun the same customer journeys on every pull request, compare results with a baseline, and post a report to GitHub. Emphasize reproducibility and newly introduced friction.

## B. Accessibility & Nontechnical User Simulator
Run constrained interaction scenarios, such as keyboard-only navigation, low technical familiarity, small screens, or limited language proficiency. **Do not claim this certifies accessibility or reproduces disabled users' lived experiences.**

## C. AI Customer Chaos Testing
Agents intentionally interrupt signup, change decisions, submit invalid information, navigate backward, open multiple tabs, and resume abandoned workflows.

**Recommended MVP (4 weeks, direction A):**
- Week 1: Browser runner and one reliable signup journey.
- Week 2: Three configurable personas, screenshots, task evaluation.
- Week 3: Baseline comparisons and GitHub PR integration.
- Week 4: Reports, onboarding, documentation, and billing.

**Suggested stack:** TypeScript, Playwright, Next.js, PostgreSQL, Redis/BullMQ, isolated browser containers, GitHub App, optional Python agent runner.

**Monetization hypothesis:** $29/month for indie developers, $99/month for small teams, usage-based pricing for larger customers.

**First users / validation:** Offer free onboarding or regression audits to indie SaaS founders. Test five real applications before and after UI changes, and measure how often developers agree with identified issues.

**Main risk:** Agent failures can be mistaken for UX failures. Require repeat runs, evidence, confidence indicators, and explicit distinction between agent error and actual regression. Synthetic users supplement rather than replace real-user testing.

## Other

- crawl users app and automatically suggest tests, setup skills, etc...

# Agent guidelines

These rules apply to every agent and every human working in this repository.

## Language

- Write everything in English: code, comments, docs, test names and commit messages.

## Commits

- Use Conventional Commits: `feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `chore:`.
- Write one line only. No body.
- Do not add AI attribution. No `Co-Authored-By`, no "Generated with".
- Make one logical change per commit.

## YAGNI

- Build only what the current task needs. No "for later" code.
- Before you add a route, a dependency, a layer or an option, ask: what breaks without it? If nothing breaks, do not add it.

## NestJS first

- If NestJS has a standard way to do something, use it: modules, providers, `ValidationPipe`,
  `@nestjs/config`, `@nestjs/mongoose`, `@nestjs/schedule`, `@nestjs/terminus`, lifecycle hooks,
  `@nestjs/testing`.
- Do not wrap or replace what the framework gives you.

## Smallest complete change

Take the first option that fully works:

1. Does it need to exist? If not, skip it and name it in one line.
2. Does the codebase already have it? Use it the way the surrounding code does.
3. Does Node, NestJS or an installed dependency have it? Use it. Never add a dependency for a few lines.
4. Otherwise, write the minimum code that works.

- Finish every part the change touches: callers, tests, fixtures, config.
- No abstraction, wrapper, option or config that nobody asked for.
- Comment only the "why" that the code cannot show, in one line. Design decisions are the exception (see below).
- A shortcut with a known limit gets a comment: `shortcut: <the limit>, <when to upgrade>`.
- Between options of equal size, take the one that is correct on edge cases.

Never cut: validation at trust boundaries, error handling that prevents data loss, security.

## Design decisions

- Every decision that answers an operating condition of the assignment (duplicates, ordering,
  crashes, timeouts, backlog) is documented in two places:
  - a short "why" comment at the code that implements it, with the trade-off it accepts (two lines at most);
  - a line in the "Problems and decisions" section of the README.
- When you change one, update the other in the same commit.

## Tests

- New non-trivial logic gets a test.
- E2e tests run against the real MongoDB from `docker compose`. No in-memory database.
- Every e2e test starts from an empty collection. One test never depends on another.

## Before you finish

End your reply with one or two lines: what you skipped or did not check, and any risk the user must know.

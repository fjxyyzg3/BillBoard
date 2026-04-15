# Household Accounting App Design

Date: 2026-04-16

## 1. Scope and Goals

This document defines the first production version of a household accounting app for two users. The product is intended for daily income and expense tracking across phone, tablet, and desktop, with a strong bias toward fast entry, simple maintenance, and self-hosted deployment.

Confirmed product constraints:

- Two independent accounts
- One shared household ledger
- Web app with PWA packaging
- Devices include Android, iPhone, iPad, Windows, and macOS
- Public internet access is required
- Deployment is self-hosted at home
- Online-first; no offline sync in v1
- Statistics must support three perspectives: household, user A, user B
- Transactions belong to a specific person rather than a shared "household" actor
- Product scope is intentionally minimal: income, expense, categories, notes, and reporting

Primary product goals:

- Enter a daily transaction in roughly 10 seconds
- Make monthly household spending easy to understand at a glance
- Keep architecture simple enough to operate at home without paid SaaS dependencies
- Keep the first version small enough to finish and maintain

## 2. Recommended Architecture

Recommended solution: a single Next.js application with PostgreSQL, reverse-proxied by Caddy, deployed via Docker Compose on a home server.

High-level request flow:

1. User opens the public domain in a browser or installed PWA
2. Caddy terminates HTTPS and forwards the request to the app container
3. Next.js renders pages, handles auth, and performs transaction/statistics queries
4. PostgreSQL stores application state

Why this architecture:

- One codebase covers phone and desktop
- A monolith is the right size for two users and low operational complexity
- PostgreSQL is more robust than SQLite for long-running self-hosted public access
- Caddy minimizes HTTPS and reverse proxy management overhead
- Docker Compose keeps deployment and recovery predictable

Architectural boundaries:

- No microservices
- No dedicated API service separate from the web app
- No Redis, queues, or analytics pipeline
- No offline-first sync engine
- No account balance tracking or transfer ledger in v1

## 3. Technology Selection

### 3.1 Application Stack

- Frontend and backend: `Next.js`
- UI framework: `React`
- Styling: `Tailwind CSS`
- Database: `PostgreSQL`
- ORM and migrations: `Prisma`
- Authentication: mature session-based auth library for Next.js, preferably `Auth.js`
- Runtime packaging: `Docker Compose`
- Reverse proxy and TLS: `Caddy`

Selection rationale:

- `Next.js` keeps UI and server logic in one project
- `Tailwind CSS` is sufficient for a compact mobile-first UI
- `PostgreSQL` provides stable querying, indexing, migration, and backup behavior
- `Prisma` keeps schema evolution readable in a small project
- `Auth.js` avoids hand-rolling password/session security for a public-facing site

### 3.2 Hosting Stack

Recommended long-term host priority:

1. Small Linux mini-PC or home server
2. NAS with Docker support
3. Always-on Mac
4. Always-on Windows PC

Preferred production shape:

- One always-on home device
- Docker Compose project with `web`, `db`, and `proxy` services
- Public domain pointed to home network
- Router port forwarding for `80` and `443`

## 4. Product Model

### 4.1 Users and Ownership

The system supports two logins and one shared ledger. Both users are full participants in the same household and can view or edit all transactions in that household.

The app distinguishes between:

- The person a transaction belongs to
- The person who recorded the transaction

These are separate because one spouse may sometimes record the other's expense or income.

### 4.2 Core Entities

The first version should contain exactly these business entities:

- `User`
- `Household`
- `HouseholdMember`
- `Category`
- `Transaction`

Authentication/session storage is treated as infrastructure, not core domain.

### 4.3 Entity Definitions

#### `User`

Represents a login identity.

Suggested fields:

- `id`
- `email`
- `display_name`
- `password_hash`
- `status`
- `created_at`
- `updated_at`

Notes:

- Email should be the login identifier even if email delivery is not enabled in v1
- Passwords are stored only as secure hashes

#### `Household`

Represents the shared ledger container.

Suggested fields:

- `id`
- `name`
- `base_currency`
- `timezone`
- `created_at`

Notes:

- v1 assumes a single household per deployment, but the table should still exist so the system is not hard-coded around one implicit ledger
- Default currency is `CNY`
- Default timezone is `Asia/Shanghai`

#### `HouseholdMember`

Represents a user within a household context.

Suggested fields:

- `id`
- `household_id`
- `user_id`
- `role`
- `member_name`
- `joined_at`

Notes:

- Roles only need `owner` and `member` in v1
- Statistics should filter by `HouseholdMember`, not directly by `User`

#### `Category`

Represents transaction classification.

Suggested fields:

- `id`
- `type`
- `name`
- `sort_order`
- `is_active`

Notes:

- `type` is either `income` or `expense`
- v1 should ship with default system categories
- v1 does not need a complex category management UI

Default expense categories:

- Dining
- Groceries
- Transport
- Daily Use
- Home
- Medical
- Entertainment
- Social
- Travel
- Other

Default income categories:

- Salary
- Bonus
- Reimbursement
- Refund
- Investment
- Other

#### `Transaction`

Represents a single income or expense event.

Suggested fields:

- `id`
- `household_id`
- `type`
- `actor_member_id`
- `created_by_member_id`
- `category_id`
- `amount_fen`
- `occurred_at`
- `note`
- `created_at`
- `updated_at`
- `deleted_at`

Key semantics:

- `actor_member_id`: who the transaction belongs to for reporting
- `created_by_member_id`: who entered the record into the app
- `amount_fen`: stored as integer fen to avoid floating-point errors
- `deleted_at`: soft delete marker for recovery from accidental deletion

### 4.4 Relationship Rules

- One `Household` has many `HouseholdMember`
- One `User` maps to one `HouseholdMember` in v1
- One `Transaction` belongs to one `Household`
- One `Transaction` belongs to one `Category`
- One `Transaction` belongs to one `actor_member`
- One `Transaction` belongs to one `created_by_member`

### 4.5 Core Business Rules

These rules should be enforced in the application and data validation layers:

- A transaction is either `income` or `expense`
- Amount must be greater than zero
- Amount is always stored as a positive integer in fen
- Sign is derived from `type`; the system does not store negative expense values
- Every transaction has exactly one category
- Every transaction has exactly one actor member
- Every transaction belongs to the current household
- Both household members may edit or delete any household transaction
- Deletion is soft deletion

### 4.6 Deliberate Omissions

The following concepts are intentionally not part of v1:

- Financial accounts
- Account balances
- Transfers between accounts
- Budget planning
- Asset and debt tracking
- Multi-currency support
- Attachments and receipt images
- OCR
- Tags
- Shared/non-person actor ownership

This is necessary to keep the model aligned with the actual goal: fast household spending capture and understandable reports.

## 5. Reporting Design

The reporting model is intentionally derived directly from the transaction table. There is no need for pre-aggregation jobs or analytical warehouse structures in v1.

Supported filters:

- Time range
- Perspective: household, member A, member B
- Transaction type: all, income, expense
- Category when viewing category-specific lists

Required reports:

### 5.1 Monthly Overview

For the selected scope and perspective, show:

- Total income
- Total expense
- Net result = income - expense
- Transaction count

### 5.2 Category Breakdown

For the selected time range and perspective:

- Aggregate by expense category
- Show absolute amount and proportion
- Allow click-through to filtered transaction list

### 5.3 Time Trend

Support at least:

- Last 7 days by day
- Last 30 days by day
- Last 12 months by month

The trend visualization should support drill-down from a point/bar to the underlying transactions.

### 5.4 Direct Data Source

All reports in v1 are computed from current non-deleted transactions. This keeps logic transparent and reduces synchronization bugs.

## 6. UX and Navigation Design

### 6.1 Design Principles

- Mobile-first layout
- Fast entry over configurability
- Minimal required fields
- Reports should answer questions before exposing raw filters
- Phone and desktop should use the same information architecture

### 6.2 Primary Navigation

The app should expose exactly three primary navigation entries:

- `Home`
- `Add`
- `Records`

Why only three:

- The product's daily job is to view summary, record transactions, and inspect/edit history
- A dedicated `Reports` navigation entry is unnecessary in v1 because reporting can live inside `Home`

Suggested navigation shape:

- Phone: bottom navigation
- Desktop/tablet: left rail or top navigation

### 6.3 Home Screen

The home screen should answer:

- How much came in this month?
- How much went out this month?
- Where did the money go?

Required sections:

- Perspective toggle: `Household / Me / Spouse`
- Time range selector: default `This Month`
- Summary cards: income, expense, net, transaction count
- Trend chart
- Expense category chart
- Recent transactions
- Quick action button to add a transaction

Interaction rule:

- Perspective and time range are page-level filters
- All home widgets update together when the active perspective or time range changes

### 6.4 Add Transaction Screen

This is the most important page in the product.

Required fields:

- Amount
- Type (`expense` default, `income` optional)
- Category
- Actor member

Optional fields:

- Time, default now
- Note

Input behavior:

- Focus amount field on open
- Keep layout compact
- Show categories as large, fast-tap buttons
- Default time to current time
- After save, offer:
  - add another
  - return home

Target outcome:

- Common daily expenses can be recorded with one amount entry plus two quick taps

### 6.5 Records Screen

The records screen is the history, search, and correction surface.

Default behavior:

- Show newest first
- Default to recent range, such as last 30 days

Visible data per row:

- Amount
- Type
- Category
- Actor member
- Note excerpt
- Time
- Created-by member

Supported filters:

- Time range
- Perspective
- Type
- Category

Editing:

- Open record details in a modal or drawer rather than a full page
- Allow edit of all mutable business fields
- Confirm before delete

### 6.6 Report Drill-Down

Every major statistic should lead to filtered raw records:

- Click monthly expense total -> expense list for that period
- Click category block -> records filtered to that category
- Click chart point -> records for that day/month bucket

This keeps reports explainable and reduces user distrust in totals.

### 6.7 PWA Behavior

Required PWA support:

- Installable manifest
- Home screen icon
- Standalone launch mode where supported

Explicitly out of scope for v1:

- Push notifications
- Offline entry
- Background sync
- Native-style gesture features

## 7. Security and Deployment Design

### 7.1 Public Exposure Model

The app is public-facing but should expose only the web entrypoint.

Public ports:

- `80` for HTTP redirect and certificate challenges
- `443` for HTTPS traffic

Internal-only services:

- Next.js app port
- PostgreSQL port

Non-negotiable rule:

- Database must not be exposed to the public internet

### 7.2 Reverse Proxy and TLS

Use `Caddy` for:

- Automatic HTTPS certificate provisioning
- Certificate renewal
- HTTP to HTTPS redirect
- Reverse proxying to the app container

### 7.3 Authentication Security

Required baseline controls:

- Secure password hashing (`Argon2` or `bcrypt`)
- Secure cookies with `HttpOnly`, `Secure`, `SameSite`
- Session-based auth
- Basic login rate limiting
- Temporary lockout after repeated failed login attempts
- Household membership checks on every protected read/write path
- No debugging endpoints in production

Explicitly not required in v1:

- Two-factor auth
- CAPTCHA
- Device trust management
- IP allowlisting

### 7.4 Home Network Preconditions

Before implementation is considered production-ready, confirm:

- A public domain is available
- The home network can route public traffic to the device
- The ISP connection supports real public ingress or a workable equivalent

If the home network is behind carrier-grade NAT with no inbound public access, the deployment strategy must be revised before launch.

### 7.5 Backup and Recovery

Recommended baseline:

- Daily automated PostgreSQL dump
- Local retention for 7 to 14 days
- Periodic copy to a second device or storage target

Recovery must be documented and tested. A valid recovery path is:

1. Provision a new machine
2. Install Docker and Docker Compose
3. Restore environment configuration
4. Restore the database backup
5. Start the containers
6. Validate login, record creation, and history access

## 8. Implementation Plan Shape

This design is intentionally scoped for one implementation plan and one product milestone sequence.

Recommended milestones:

### Milestone 1: Project Foundation

- Initialize Next.js app
- Configure Tailwind CSS
- Set up PostgreSQL and Prisma
- Add local Docker development setup
- Build shared app layout

Success criteria:

- App starts locally
- App connects to database
- Schema migrations run successfully

### Milestone 2: Auth and Household Foundation

- Implement login/logout
- Create household and member relations
- Restrict access by household membership

Success criteria:

- Two accounts can log in
- Both accounts can access the same household
- Unauthorized access is blocked

### Milestone 3: Transaction CRUD

- Add transaction creation
- Build record listing
- Support edit
- Support soft delete

Success criteria:

- Records can be created, edited, and deleted
- New records appear immediately in history

### Milestone 4: Reporting

- Monthly overview cards
- Perspective switching
- Trend chart
- Category chart
- Drill-down to raw records

Success criteria:

- Report totals match underlying transactions
- Perspective filters update all home widgets consistently

### Milestone 5: Production Readiness

- Add PWA manifest and icons
- Build production Docker Compose stack
- Configure Caddy and HTTPS
- Add backup automation
- Document restore flow

Success criteria:

- App is installable as PWA
- Public HTTPS access works
- Backup and restore can be demonstrated

## 9. Testing Strategy

The testing strategy should focus on correctness of the critical user flows rather than broad coverage for its own sake.

### 9.1 Unit Tests

Prioritize:

- Amount conversion helpers
- Report aggregation helpers
- Time-range calculation utilities
- Permission helper logic

### 9.2 Integration Tests

Prioritize:

- Create transaction
- Query records list
- Edit transaction
- Soft delete behavior
- Perspective-based filtering and reporting

### 9.3 End-to-End Tests

Prioritize three flows:

- Log in and create an expense
- Log in and create an income
- Verify home totals against raw records

## 10. Explicit Out-of-Scope List

The following are not part of this design and should not appear in the first implementation plan:

- Native iOS or Android apps
- Offline-first sync
- Budgets
- Account balances
- Transfers
- Assets and liabilities
- Attachments and OCR
- Complex role systems
- Multi-household support in the UI
- Third-party bank or wallet imports
- Advanced notification system

## 11. Key Risks and Mitigations

### Risk: public home deployment is unavailable

Mitigation:

- Verify public ingress capability before production deployment work

### Risk: accidental record deletion or modification

Mitigation:

- Soft delete
- Updated timestamps
- Keep created-by metadata
- Daily backups

### Risk: scope creep slows delivery

Mitigation:

- Keep v1 limited to transactions and reports only
- Reject account/budget/attachment features from the first implementation plan

### Risk: self-hosted recovery is untested

Mitigation:

- Require a restore rehearsal before calling the system production-ready

## 12. Design Summary

The recommended v1 product is a small, self-hosted, public-facing PWA for two users and one shared household ledger. It uses a monolithic Next.js application backed by PostgreSQL, exposed through Caddy over HTTPS, and deployed with Docker Compose. The data model is intentionally narrow, centered on users, household membership, categories, and transactions. The UI is optimized around three screens: Home, Add, and Records. Reporting is derived directly from transactions with household and per-person perspectives. Deployment and safety decisions prioritize low maintenance, basic public security hygiene, and routine backups over platform complexity.

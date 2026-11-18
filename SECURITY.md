# Security

SB Keyword Intelligence is an internal Succulents Box tool. The repository is public; the data and prompts are not.

- **Access.** Team members sign in with Google, and the database decides access from a protected member list. Only approved members can read or change data. The owner approves and removes members in the app.
- **Data.** Every table is limited to approved members by database policies. The public key in the page grants nothing on its own.
- **Generation.** Keyword and headline generation run on the server only after the session, membership and a daily limit are checked. The prompts are private, versioned records that only the server can read. The AI provider key never reaches the browser.
- **Search Console.** The Search Console connection uses its own read-only Google permission.

Configuration and operator steps are kept privately. Report a security concern to the repository owner privately rather than in a public issue.

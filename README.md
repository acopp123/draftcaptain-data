# draftcaptain-data

Publishes `injuries.json` for the do-you-know-ball Reddit app every ~15 minutes
(ESPN's injury feed, with Sleeper's daily list as fallback and for ID matching).
App setting: `INJURIES_URL` in `src/server/config.ts` →
`https://raw.githubusercontent.com/<your-github-username>/draftcaptain-data/main/injuries.json`

# gov-tracker

A plain-English, source-linked guide to what the federal government is doing.

- `site/` – the website (published with GitHub Pages)
- `site/data/` – data pulled from official sources by `scripts/fetch_data.py`
- `site/content/` – written explanations, maintained by hand
- `.github/workflows/update-data.yml` – **the refresh button**: Actions tab → "Update data" → "Run workflow"

Sources: U.S. Treasury Fiscal Data, USAspending.gov, Congress.gov API, Voteview (UCLA), FEC, and the
public-domain `unitedstates/congress-legislators` dataset.

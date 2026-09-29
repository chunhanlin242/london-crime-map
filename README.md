# London Crime Map

An interactive map of recorded crime in London, year to date. Start with the five
sub-regions (Central, North, East, South, West), click into a borough, then into its wards.

- Rank by **crimes per 1,000 residents** (default) or **total crimes**
- Filter by crime type: all crime, residential burglary, violence & sexual offences,
  robbery & theft from the person
- London-wide ward league table: the safest and the highest-crime wards, top N

No build step and no dependencies — it's one HTML file plus a generated data file.

## Reading the numbers

- Rates use **residents** (2021 Census). Commuters and tourists aren't counted, so
  Westminster, Soho and other town centres always look high. For "is it safe to live
  here", residential burglary is the better guide.
- Colours compare like with like: sub-regions with each other, boroughs within a
  sub-region, wards within a borough.
- About 3% of crimes aren't assigned to a ward, so ward totals add up to slightly less
  than borough totals.
- The City of London is policed by the City of London Police and isn't in the Met data.
- Sub-regions follow the London Plan (2016).

## Updating the data

The Met publishes new figures roughly monthly. To rebuild `data/crime-map-data.js`
(Node 18+):

```bash
node scripts/build-crime-map.js
```

The script downloads the latest files, uses every month of the most recent year in them,
and prints a few consistency checks.

## Data sources

| Data | Source |
|---|---|
| Recorded crime by borough and ward | Metropolitan Police Service, [London Datastore](https://data.london.gov.uk/dataset/recorded_crime_summary) |
| Population by ward | 2021 Census TS001, [Nomis](https://www.nomisweb.co.uk/) |
| Ward and borough boundaries (Dec 2022) | [ONS Open Geography Portal](https://geoportal.statistics.gov.uk/) |

Contains Metropolitan Police Service data and Office for National Statistics data licensed
under the [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/).
Contains OS data © Crown copyright and database right 2022.

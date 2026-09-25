# Third-party data used by the benchmark

No third-party corpus is included in this repository. The benchmark scripts fetch
data on demand into `bench/data/`, which is gitignored, and each source keeps its
own licence:

- Amazon FoodOrdering dataset — CC BY-NC 4.0.
  https://github.com/amazon-science/food-ordering-semantic-parsing-dataset
  Fetched by `bench/foodordering.ts`. Non-commercial terms apply to that data; they
  do not apply to this software.

- MS-SNSD noise recordings (Microsoft) — MIT.
  https://github.com/microsoft/MS-SNSD
  Fetched by `npm run fetch:noise`.

- DEMAND noise database (Thiemann, Ito & Vincent) — CC BY 4.0, optional.
  https://zenodo.org/records/1227121
  Used only when an archive is supplied via `npm run fetch:noise -- --demand <path>`.

- Google Taskmaster-2 food-ordering dialogues — CC BY 4.0.
  https://github.com/google-research-datasets/Taskmaster
  Used as a reference for phrasing in the test suite; no data is redistributed.

Speech used by the benchmark and the in-page regression tests is generated at run
time with the AssemblyAI Voice Agent API under the user's own account.

"Burger Lab" is a fictional brand. No real restaurant chain is affiliated, endorsed
or depicted.

import { fetchGoodreadsByIsbn } from "../src/lib/ingest/goodreads";

const isbn = process.argv[2] ?? "9780735219090";
fetchGoodreadsByIsbn(isbn).then((result) => {
  console.log(JSON.stringify(result, null, 2));
});

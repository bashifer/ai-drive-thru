import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Development only: saves a lane recorded with `/?record` to public/replays/, where it
 * can be committed and replayed by anyone, with no key. A deployed instance has no
 * business writing files, so everywhere else this route does not exist.
 */
export async function POST(req: Request) {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const name = (new URL(req.url).searchParams.get("name") ?? "lane").replace(/[^a-z0-9-]/gi, "") || "lane";
  let tape: { version?: number; cars?: unknown[] };
  try {
    tape = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  if (tape.version !== 1 || !Array.isArray(tape.cars) || tape.cars.length === 0) {
    return NextResponse.json({ error: "Nothing recorded: run at least one regression test first" }, { status: 400 });
  }

  const dir = resolve(process.cwd(), "public/replays");
  await mkdir(dir, { recursive: true });
  const file = resolve(dir, `${name}.json`);
  const body = JSON.stringify(tape);
  await writeFile(file, body);

  return NextResponse.json({ path: `public/replays/${name}.json`, cars: tape.cars.length, bytes: body.length });
}

import { describe, expect, it } from "vitest";
import { capabilitiesForSource } from "./sourceCapabilities";

/** What the backend stores for a scan of another machine (see `SshSource::to_source_json`). */
const SSH = '{"type":"ssh","destination":"alex@nas","port":null,"root":"/srv/media"}';

const ALL = { reveal: true, lockHolders: true, preview: true, mutate: true };
const NONE = { reveal: false, lockHolders: false, preview: false, mutate: false };

describe("capabilitiesForSource", () => {
  it("allows everything for a scan of this machine", () => {
    expect(capabilitiesForSource("local")).toEqual(ALL);
  });

  it("allows everything when the index predates source tracking", () => {
    expect(capabilitiesForSource(undefined)).toEqual(ALL);
  });

  it("allows nothing for a scan over SSH", () => {
    expect(capabilitiesForSource(SSH)).toEqual(NONE);
  });

  it("allows nothing for a source it doesn't recognise", () => {
    expect(capabilitiesForSource("")).toEqual(NONE);
    expect(capabilitiesForSource("s3://bucket")).toEqual(NONE);
  });
});

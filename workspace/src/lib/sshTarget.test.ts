import { describe, expect, it } from "vitest";
import { hostError, portError, rootError } from "./sshTarget";

describe("hostError", () => {
  it("accepts user@host, a bare host and a config alias", () => {
    for (const ok of ["alex@nas", "nas", "nas.local", "build-box", "alex@10.0.0.4"]) {
      expect(hostError(ok)).toBeNull();
    }
  });

  it("rejects anything ssh would read as an option", () => {
    // The reason this validation exists: ssh runs ProxyCommand on THIS machine.
    expect(hostError("-oProxyCommand=calc.exe")).not.toBeNull();
    expect(hostError("  -oProxyCommand=x")).not.toBeNull();
    expect(hostError("-p2222")).not.toBeNull();
  });

  it("rejects shell metacharacters and spaces", () => {
    for (const bad of ["nas; calc", "nas$(whoami)", "nas host", "nas`id`", "nas|tee", "nas&x"]) {
      expect(hostError(bad)).not.toBeNull();
    }
  });

  it("says nothing about an empty field", () => {
    expect(hostError("")).toBeNull();
    expect(hostError("   ")).toBeNull();
  });
});

describe("rootError", () => {
  it("accepts an absolute POSIX path", () => {
    expect(rootError("/home/alex")).toBeNull();
    expect(rootError("  /srv/archive  ")).toBeNull();
  });

  it("rejects a relative path, a Windows path and an option", () => {
    for (const bad of ["home/alex", "~/media", "C:\\Users\\alex", "-oX=1"]) {
      expect(rootError(bad)).not.toBeNull();
    }
  });

  it("says nothing about an empty field", () => {
    expect(rootError("")).toBeNull();
  });
});

describe("portError", () => {
  it("accepts empty and a real port", () => {
    expect(portError("")).toBeNull();
    expect(portError("22")).toBeNull();
    expect(portError("65535")).toBeNull();
  });

  it("rejects out-of-range and non-numeric ports", () => {
    for (const bad of ["0", "65536", "99999", "22a", "-1", "2 2"]) {
      expect(portError(bad)).not.toBeNull();
    }
  });
});

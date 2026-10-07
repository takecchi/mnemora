import { describe, expect, it } from "vitest";
import { planConsumerProjects } from "../check-consumer-install-lib.mjs";

describe("planConsumerProjects の割り当ての境界", () => {
  it("名前が別のパッケージ名の接頭辞になっていても、入口はそれぞれ自分のプロジェクトにだけ割り当てる", () => {
    const manifests = [
      { name: "@m/core", tarball: "/p/core.tgz" },
      { name: "@m/core-extra", tarball: "/p/core-extra.tgz" },
    ];
    const plan = planConsumerProjects(manifests, ["@m/core", "@m/core-extra", "@m/core-extra/sub"]);
    expect(plan.find((p) => p.name === "@m/core").entries).toEqual(["@m/core"]);
    expect(plan.find((p) => p.name === "@m/core-extra").entries).toEqual([
      "@m/core-extra",
      "@m/core-extra/sub",
    ]);
  });

  it("peerDependencies・devDependencies で名指ししただけの兄弟の tarball は入れない", () => {
    const manifests = [
      { name: "@m/core", tarball: "/p/core.tgz" },
      {
        name: "@m/testkit",
        tarball: "/p/testkit.tgz",
        peerDependencies: { "@m/core": "^1" },
        devDependencies: { "@m/core": "^1" },
      },
    ];
    const plan = planConsumerProjects(manifests, ["@m/core", "@m/testkit"]);
    expect(plan.find((p) => p.name === "@m/testkit").installTarballs).toEqual(["/p/testkit.tgz"]);
  });
});

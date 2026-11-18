import type { TestModule } from "vitest/node";
import type { Reporter } from "vitest/reporters";
import { writeFileTimings } from "./timing";

export default class TimingReporter implements Reporter {
  onTestRunEnd(modules: ReadonlyArray<TestModule>) {
    writeFileTimings(modules.map((module) => ({
      file: module.moduleId,
      durationMs: module.diagnostic().duration,
    })));
  }
}

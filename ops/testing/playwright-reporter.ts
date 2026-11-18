import type { Reporter, Suite, TestCase, TestResult } from "@playwright/test/reporter";
import { writeFileTimings, type FileTiming } from "./timing";

export default class TimingReporter implements Reporter {
  private files = new Map<string, number>();
  private suite?: Suite;

  onBegin(_config: unknown, suite: Suite) { this.suite = suite; }

  onTestEnd(test: TestCase, result: TestResult) {
    this.files.set(test.location.file, (this.files.get(test.location.file) ?? 0) + result.duration);
  }

  onEnd() {
    const outcomes = new Map<string, FileTiming>();
    for (const test of this.suite?.allTests() ?? []) {
      const file = test.location.file;
      const timing = outcomes.get(file) ?? { file, durationMs: this.files.get(file) ?? 0, passed: true, tests: 0 };
      timing.tests = (timing.tests ?? 0) + 1;
      timing.passed &&= test.outcome() === "expected" || (test.outcome() === "skipped" && test.expectedStatus === "skipped");
      outcomes.set(file, timing);
    }
    writeFileTimings([...outcomes.values()]);
  }
}

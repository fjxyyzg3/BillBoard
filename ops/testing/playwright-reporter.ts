import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import { writeFileTimings } from "./timing";

export default class TimingReporter implements Reporter {
  private files = new Map<string, number>();

  onTestEnd(test: TestCase, result: TestResult) {
    this.files.set(test.location.file, (this.files.get(test.location.file) ?? 0) + result.duration);
  }

  onEnd() {
    writeFileTimings([...this.files].map(([file, durationMs]) => ({ file, durationMs })));
  }
}

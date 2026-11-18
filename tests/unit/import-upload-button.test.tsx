import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ImportUploadButton } from "@/components/import-upload-button";
import { getMessages } from "@/lib/i18n";

const status = vi.hoisted(() => ({ pending: false }));
vi.mock("react-dom", async (original) => ({ ...await original<typeof import("react-dom")>(), useFormStatus: () => status }));

describe("import upload progress", () => {
  it("only disables submission while the server is processing the file", () => {
    status.pending = false;
    expect(renderToStaticMarkup(<ImportUploadButton locale="en-US" />)).not.toContain('disabled=""');
    status.pending = true;
    const markup = renderToStaticMarkup(<ImportUploadButton locale="en-US" />);
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain(getMessages("en-US").import.uploading);
  });
});

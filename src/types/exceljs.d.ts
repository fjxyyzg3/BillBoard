import "exceljs";

declare module "exceljs" {
  interface Xlsx {
    load(buffer: Buffer<ArrayBufferLike>, options?: Partial<XlsxReadOptions>): Promise<Workbook>;
  }
}

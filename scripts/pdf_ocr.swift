// pdf_ocr.swift — render PDF pages with PDFKit and OCR them with Apple Vision.
// Usage: swift pdf_ocr.swift <file.pdf> [pages e.g. 3,4,5] [scale]
// Output: JSON array [{page, text, conf, x, y, w, h}] on stdout.
// Coordinates are normalised (0..1), origin top-left.
import Foundation
import PDFKit
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count >= 2, let doc = PDFDocument(url: URL(fileURLWithPath: args[1])) else {
  FileHandle.standardError.write("cannot open pdf\n".data(using: .utf8)!); exit(1)
}
var pages: [Int] = Array(1...doc.pageCount)
if args.count >= 3, !args[2].isEmpty, args[2] != "all" {
  pages = args[2].split(separator: ",").compactMap { Int($0) }
}
let scale: CGFloat = args.count >= 4 ? CGFloat(Double(args[3]) ?? 4) : 4

var out: [[String: Any]] = []
for p in pages {
  guard p >= 1, p <= doc.pageCount, let page = doc.page(at: p - 1) else { continue }
  let box = page.bounds(for: .mediaBox)
  let w = Int(box.width * scale), h = Int(box.height * scale)
  guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { continue }
  ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
  ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
  ctx.scaleBy(x: scale, y: scale)
  page.draw(with: .mediaBox, to: ctx)
  guard let img = ctx.makeImage() else { continue }
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.recognitionLanguages = ["ru-RU", "en-US"]
  req.usesLanguageCorrection = false
  try? VNImageRequestHandler(cgImage: img, options: [:]).perform([req])
  for obs in req.results ?? [] {
    guard let c = obs.topCandidates(1).first else { continue }
    let b = obs.boundingBox
    out.append(["page": p, "text": c.string, "conf": c.confidence,
                "x": b.minX, "y": 1 - b.maxY, "w": b.width, "h": b.height])
  }
}
let data = try! JSONSerialization.data(withJSONObject: out, options: [])
FileHandle.standardOutput.write(data)

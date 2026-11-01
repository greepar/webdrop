import Foundation

var result: [String: String] = [:]

let isoFormatter = ISO8601DateFormatter()

let date = isoFormatter.date(from: "2026-11-01T12:34:56Z")!

for input in [
    "1970-01-01T00:00:00Z", "2024-02-29T23:59:59Z", "2038-01-19T03:14:08Z", "2026-11-01T20:34:56+08:00", "invalid",
] {
    result["iso:\(input)"] = isoFormatter.date(from: input).map(isoFormatter.string) ?? "nil"
}

for identifier in [
    "en_US_POSIX", "en_US", "zh_CN", "zh_TW", "ja_JP", "de_DE", "fr_FR", "ru_RU", "es_ES", "pt_BR", "it_IT", "ko_KR",
    "ar_EG", "th_TH", "hi_IN",
] {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: identifier)
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.dateFormat = "EEEE, d MMMM yyyy HH:mm:ss zzzz"
    result["date:\(identifier)"] = formatter.string(from: date)
    let number = NumberFormatter()
    number.locale = Locale(identifier: identifier)
    number.numberStyle = .decimal
    result["number:\(identifier)"] = number.string(from: NSNumber(value: 1234567.89)) ?? "nil"
}

for identifier in ["UTC", "Asia/Shanghai", "America/New_York", "Europe/Berlin"] {
    result["timezone:\(identifier)"] =
        TimeZone(identifier: identifier).map { String($0.secondsFromGMT(for: date)) } ?? "nil"
}

for text in ["中文文件📁", "e\u{301}", "ภาษาไทย", "日本語テスト", "العربية", "👨‍👩‍👧‍👦"] {
    result["unicode:\(text)"] = "\(text.count):\(text.utf8.count):" + text.lowercased()
    let regex = try NSRegularExpression(pattern: "\\b\\w+\\b", options: [.useUnicodeWordBoundaries])
    result["regex:\(text)"] = regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).map {
        String(text[Range($0.range, in: text)!])
    }.joined(separator: "|")
}

result["encoding:shiftJIS"] = "日本語".data(using: .shiftJIS)?.base64EncodedString() ?? "nil"

result["url:idna"] = URL(string: "https://例子.测试/中文")?.absoluteString ?? "nil"

print(
    String(
        decoding: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys, .prettyPrinted]),
        as: UTF8.self
    )
)

// Windows cookie timestamps: Foundation parser for the HTTP-date formats accepted upstream.
private func parseCookieTime(_ timestampUTF8: String.UTF8View.SubSequence) -> Int64? {
    guard !timestampUTF8.contains(where: { $0 < 0x20 || $0 == 0x7f }) else { return nil }
    let text = String(decoding: timestampUTF8, as: UTF8.self)
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.isLenient = false
    formatter.twoDigitStartDate = Date(timeIntervalSince1970: -31536000)
    for format in ["EEE, dd MMM yyyy HH:mm:ss zzz", "EEE, dd-MMM-yy HH:mm:ss zzz", "EEE MMM dd HH:mm:ss yyyy", "EEE, dd MMM yyyy HH:mm:ss", "EEE, dd-MMM-yy HH:mm:ss"] {
        formatter.dateFormat = format
        if let date = formatter.date(from: text) { return Int64(date.timeIntervalSince1970) }
    }
    return nil
}

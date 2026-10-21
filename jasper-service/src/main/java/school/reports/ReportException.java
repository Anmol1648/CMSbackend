package school.reports;

/** A problem to tell the backend about: a mistake in the design, data that doesn't fit, a limit reached. */
final class ReportException extends RuntimeException {
    final int status;
    /** design | data | limit | auth | internal */
    final String kind;
    final String detail;

    ReportException(int status, String kind, String message, String detail) {
        super(message);
        this.status = status;
        this.kind = kind;
        this.detail = detail;
    }
}

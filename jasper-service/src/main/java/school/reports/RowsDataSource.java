package school.reports;

import net.sf.jasperreports.engine.JRField;
import net.sf.jasperreports.engine.JRRewindableDataSource;

import java.util.List;
import java.util.Map;

/** The rows sent by the backend, one report record each; values are turned into the type each field declares. */
final class RowsDataSource implements JRRewindableDataSource {
    private final List<Map<String, Object>> rows;
    private int index = -1;

    RowsDataSource(List<Map<String, Object>> rows) {
        this.rows = rows;
    }

    @Override
    public boolean next() {
        return ++index < rows.size();
    }

    @Override
    public Object getFieldValue(JRField field) {
        Map<String, Object> row = rows.get(index);
        return Values.coerce(row == null ? null : row.get(field.getName()), field.getValueClass(), "field " + field.getName() + " (row " + (index + 1) + ")");
    }

    @Override
    public void moveFirst() {
        index = -1;
    }
}

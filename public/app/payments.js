var paymentsTable = null;
var paymentsData = [];

function fmtMoney(n) { return '$' + (Number(n) || 0).toFixed(2); }
function fmtDate(s) { if (!s) return '—'; var d = new Date(s); if (isNaN(d)) return s; return d.toISOString().slice(0, 10); }

function typeBadge(t) {
    var label = t === 'artist' ? 'Artist' : t === 'referral' ? 'Referral' : t === 'additional' ? 'Additional' : t;
    return '<span class="pay-type-badge pay-type-' + t + '">' + label + '</span>';
}

function daysClass(d) {
    if (d === null || d === undefined) return '';
    if (d <= 30) return 'ok';
    if (d <= 90) return 'warn';
    return 'danger';
}

function rowClass(d) {
    if (d === null || d === undefined) return '';
    if (d > 90) return 'pay-overdue-row';
    if (d <= 30) return 'pay-recent-row';
    return '';
}

$(function() {
    App.init(function() {
        feather.replace();
        $('#curr-year').text(new Date().getFullYear());
        loadPayments();
        $('#type-filter').on('change', applyFilter);
        $('#name-search').on('input', function() {
            if (paymentsTable) paymentsTable.search($(this).val()).draw();
        });
    });
});

function loadPayments() {
    App.api('GET', '/api/payments/summary').done(function(rows) {
        paymentsData = rows || [];
        renderTable();
        renderStats();
    });
}

function renderStats() {
    var total = paymentsData.reduce(function(s, r) { return s + (r.totalPaid || 0); }, 0);
    var overdue = paymentsData.filter(function(r) { return r.daysSinceLastPaid !== null && r.daysSinceLastPaid > 90; }).length;
    var recent = paymentsData.filter(function(r) { return r.daysSinceLastPaid !== null && r.daysSinceLastPaid <= 30; }).length;
    $('#stat-people').text(paymentsData.length.toLocaleString());
    $('#stat-total').text(fmtMoney(total));
    $('#stat-overdue').text(overdue);
    $('#stat-recent').text(recent);
}

function applyFilter() {
    renderTable();
}

function renderTable() {
    if (paymentsTable) {
        paymentsTable.destroy();
        $('#payments-table tbody').empty();
    }

    var filterType = $('#type-filter').val();
    var filtered = filterType
        ? paymentsData.filter(function(r) { return r.type === filterType; })
        : paymentsData;

    var tbody = $('#payments-table tbody');
    var rowsHtml = filtered.map(function(r) {
        var safeName = $('<div>').text(r.name).html();
        var dataAttrName = r.name.replace(/"/g, '&quot;');
        return '<tr class="' + rowClass(r.daysSinceLastPaid) + '">' +
            '<td><strong>' + safeName + '</strong></td>' +
            '<td>' + typeBadge(r.type) + '</td>' +
            '<td class="text-right" data-order="' + (r.totalPaid || 0) + '"><span class="text-success font-weight-bold">' + fmtMoney(r.totalPaid) + '</span></td>' +
            '<td class="text-center">' + (r.paymentCount || 0) + '</td>' +
            '<td data-order="' + (r.lastPaidAt ? new Date(r.lastPaidAt).getTime() : 0) + '">' + fmtDate(r.lastPaidAt) + '</td>' +
            '<td class="text-right" data-order="' + (r.daysSinceLastPaid === null ? -1 : r.daysSinceLastPaid) + '"><span class="pay-days ' + daysClass(r.daysSinceLastPaid) + '">' + (r.daysSinceLastPaid === null ? '—' : (r.daysSinceLastPaid + ' days')) + '</span></td>' +
            '<td class="text-center"><button class="btn btn-sm btn-outline-primary" onclick="openHistory(\'' + dataAttrName + '\', \'' + r.type + '\')"><i data-feather="clock" style="width:13px;height:13px;"></i> History</button></td>' +
        '</tr>';
    }).join('');
    tbody.html(rowsHtml || '<tr><td colspan="7" class="text-center text-muted py-4">No payment data yet. Add some revenue entries first.</td></tr>');

    paymentsTable = $('#payments-table').DataTable({
        order: [[5, 'desc']], // sort by days-since-last-paid desc
        pageLength: 25,
        lengthMenu: [10, 25, 50, 100],
        language: { search: '', searchPlaceholder: 'Quick search…' },
        dom: 'lfrtip'
    });

    setTimeout(function() { feather.replace(); }, 50);
}

function openHistory(name, type) {
    $('#hist-name').text(name);
    $('#hist-rows').html('<div class="text-muted small">Loading…</div>');
    $('#hist-total').text('$0.00'); $('#hist-count').text('0'); $('#hist-avg').text('$0.00');
    $('#historyModal').modal('show');

    App.api('GET', '/api/payments/history?name=' + encodeURIComponent(name) + '&type=' + encodeURIComponent(type)).done(function(rows) {
        rows = rows || [];
        var total = rows.reduce(function(s, r) { return s + (r.amount || 0); }, 0);
        var avg = rows.length ? total / rows.length : 0;
        $('#hist-total').text(fmtMoney(total));
        $('#hist-count').text(rows.length);
        $('#hist-avg').text(fmtMoney(avg));

        if (!rows.length) {
            $('#hist-rows').html('<div class="text-muted text-center py-4">No payments found.</div>');
            return;
        }
        var html = rows.map(function(r) {
            var ctxSafe = $('<div>').text(r.context || '').html();
            return '<div class="pay-history-row">' +
                '<span class="date">' + fmtDate(r.paidAt) + '</span>' +
                '<span class="ctx">' + ctxSafe + '</span>' +
                '<span>' + typeBadge(r.type) + '</span>' +
                '<span class="amt">' + fmtMoney(r.amount) + '</span>' +
            '</div>';
        }).join('');
        $('#hist-rows').html(html);
    });
}

// /app/referrers.js — Referrers registry page
var refsTable;

App.init(function() {
    feather.replace();
    loadReferrers();
});

function loadReferrers() {
    App.api('GET', '/api/referrers').done(function(rows) {
        var tbody = $('#referrers-body').empty();
        rows.forEach(function(r) {
            tbody.append(
                '<tr>' +
                  '<td><strong>' + esc(r.name) + '</strong></td>' +
                  '<td>' + esc(r.phone || '—') + '</td>' +
                  '<td>' + esc(r.email || '—') + '</td>' +
                  '<td>' + esc(r.social || '—') + '</td>' +
                  '<td class="text-center"><span class="badge badge-info">' + (r.artist_count || 0) + '</span></td>' +
                  '<td class="text-right"><span class="text-success font-weight-bold">' + App.formatCurrency(r.total_earned || 0) + '</span></td>' +
                  '<td><small class="text-muted">' + esc((r.notes || '').slice(0, 60)) + (r.notes && r.notes.length > 60 ? '…' : '') + '</small></td>' +
                  '<td class="admin-only">' +
                    '<button class="btn btn-sm btn-outline-info" title="Edit" onclick="editReferrer(' + r.id + ')"><i data-feather="edit-2" style="width:14px;height:14px;"></i></button> ' +
                    '<button class="btn btn-sm btn-outline-danger" title="Delete" onclick="deleteReferrer(' + r.id + ', \'' + esc(r.name).replace(/'/g, "\\'") + '\')"><i data-feather="trash-2" style="width:14px;height:14px;"></i></button>' +
                  '</td>' +
                '</tr>'
            );
        });
        feather.replace();

        if (refsTable) refsTable.destroy();
        refsTable = $('#referrers-table').DataTable({
            order: [[0, 'asc']],
            pageLength: 25,
            columnDefs: [{ targets: -1, orderable: false }]
        });

        // Cache for autofill in modal
        window._referrersCache = rows;
    });
}

function openAdd() {
    $('#ref-modal-title').text('Add Referrer');
    $('#ref-id').val('');
    $('#referrer-form')[0].reset();
    $('#referrerModal').modal('show');
}

function editReferrer(id) {
    var r = (window._referrersCache || []).find(function(x) { return x.id === id; });
    if (!r) return;
    $('#ref-modal-title').text('Edit Referrer');
    $('#ref-id').val(r.id);
    $('#ref-name').val(r.name);
    $('#ref-phone').val(r.phone || '');
    $('#ref-email').val(r.email || '');
    $('#ref-social').val(r.social || '');
    $('#ref-notes').val(r.notes || '');
    $('#referrerModal').modal('show');
}

function saveReferrer() {
    var id = $('#ref-id').val();
    var data = {
        name: $('#ref-name').val().trim(),
        phone: $('#ref-phone').val().trim() || null,
        email: $('#ref-email').val().trim() || null,
        social: $('#ref-social').val().trim() || null,
        notes: $('#ref-notes').val().trim() || null
    };
    if (!data.name) { App.showError('Name is required'); return; }
    var method = id ? 'PUT' : 'POST';
    var url = id ? '/api/referrers/' + id : '/api/referrers';
    App.api(method, url, data).done(function() {
        $('#referrerModal').modal('hide');
        App.showSuccess('Referrer ' + (id ? 'updated' : 'added'));
        loadReferrers();
    });
}

function deleteReferrer(id, name) {
    if (!confirm('Delete referrer "' + name + '"?\n\nIf they are linked to any artist, the entry will be soft-deleted (existing artist links remain).')) return;
    App.api('DELETE', '/api/referrers/' + id).done(function(res) {
        if (res.softDeleted) {
            App.showSuccess('Marked inactive (still linked to ' + res.artistsAffected + ' artist[s])');
        } else {
            App.showSuccess('Referrer deleted');
        }
        loadReferrers();
    });
}

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

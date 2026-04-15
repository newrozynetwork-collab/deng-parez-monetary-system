var artistsData = [];
var artistsTable = null;

App.init(function() {
    loadArtists();
    initInstantSearch();
});

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, function(m) {
        return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[m];
    });
}

function loadArtists() {
    App.api('GET', '/api/artists').done(function(artists) {
        artistsData = artists;
        var tbody = $('#artists-body');
        tbody.empty();
        artists.forEach(function(a) {
            var refCount = a.referrals ? a.referrals.length : 0;
            var refNames = (a.referrals || []).map(function(r) { return r.referrer_name; }).join(' ');
            var refText = refCount > 0 ? refCount + ' level(s)' : '<span class="text-muted">None</span>';
            // Hidden searchable data
            var searchable = [
                a.name, a.nickname || '', a.revenue_type, a.notes || '', refNames
            ].join(' ');
            tbody.append(
                '<tr data-search="' + escapeHtml(searchable.toLowerCase()) + '">' +
                '<td><a href="/artists/' + a.id + '" class="text-primary font-weight-medium">' + escapeHtml(a.name) + '</a></td>' +
                '<td>' + escapeHtml(a.nickname || '-') + '</td>' +
                '<td>' + App.sourceBadge(a.revenue_type) + '</td>' +
                '<td>' + a.artist_split_pct + '%</td>' +
                '<td>' + a.company_split_pct + '%</td>' +
                '<td>' + a.bank_fee_pct + '%</td>' +
                '<td>' + refText + '</td>' +
                '<td class="admin-only">' +
                    '<button class="btn btn-sm btn-info mr-1" onclick="editArtist(' + a.id + ')"><i class="ti-pencil"></i></button>' +
                    '<button class="btn btn-sm btn-danger" onclick="confirmDelete(' + a.id + ',\'' + a.name.replace(/'/g, "\\'") + '\')"><i class="ti-trash"></i></button>' +
                '</td>' +
                '</tr>'
            );
        });
        if ($.fn.DataTable.isDataTable('#artists-table')) {
            $('#artists-table').DataTable().destroy();
        }
        artistsTable = $('#artists-table').DataTable({
            responsive: true,
            order: [[0, 'asc']],
            pageLength: 25,
            lengthMenu: [[10, 25, 50, 100, -1], [10, 25, 50, 100, 'All']],
            dom: 'lrtip', // hide default search since we have our own
            language: { search: '', searchPlaceholder: 'Filter...' }
        });
        updateResultCount();
        feather.replace();

        // Re-apply current filter if search box has value
        var q = $('#artist-search').val();
        if (q) filterArtists(q);
    });
}

function initInstantSearch() {
    var $input = $('#artist-search');
    var $clear = $('#clear-search');

    // Focus search with Ctrl+K / Cmd+K
    $(document).on('keydown', function(e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
            e.preventDefault();
            $input.focus().select();
        }
        if (e.key === 'Escape' && document.activeElement === $input[0]) {
            $input.val('').trigger('input');
        }
    });

    // Instant search as you type
    $input.on('input', function() {
        var q = $(this).val();
        $clear.toggle(q.length > 0);
        filterArtists(q);
    });

    $clear.on('click', function() {
        $input.val('').trigger('input').focus();
    });
}

function filterArtists(query) {
    if (!artistsTable) return;
    // Use DataTables' search API (which is instant)
    artistsTable.search(query).draw();
    updateResultCount();
}

function updateResultCount() {
    if (!artistsTable) return;
    var info = artistsTable.page.info();
    var total = info.recordsTotal;
    var filtered = info.recordsDisplay;
    var q = $('#artist-search').val();
    if (q && filtered !== total) {
        $('#result-count').html('<strong>' + filtered + '</strong> of ' + total + ' artists');
    } else {
        $('#result-count').html('<strong>' + total + '</strong> artists');
    }
}

function exportArtists(format) {
    // Build query with current search so export matches what user sees
    var q = $('#artist-search').val();
    if (q && artistsTable) {
        // For filtered export, use client-side CSV generation
        if (format === 'csv' || format === 'xlsx') {
            clientSideExport(format, q);
            return;
        }
    }
    // Otherwise download from server (full list with computed totals)
    window.location.href = '/api/artists/export/download?format=' + format;
}

function clientSideExport(format, query) {
    // Get only visible (filtered) rows
    var rows = artistsTable.rows({ search: 'applied' }).data();
    var filtered = [];
    for (var i = 0; i < rows.length; i++) {
        // Find the artist by name from the rendered row
        var nameCell = $(rows[i][0]).text() || rows[i][0];
        var nameMatch = nameCell.match(/[^<]+$/);
        filtered.push(nameCell.replace(/<[^>]+>/g, '').trim());
    }
    var matchingArtists = artistsData.filter(function(a) {
        return filtered.indexOf(a.name) !== -1;
    });

    if (format === 'csv') {
        downloadCSV(matchingArtists, 'artists-filtered-' + new Date().toISOString().slice(0,10) + '.csv');
    } else {
        // For xlsx with filter, fall back to server (full list) and note
        App.showSuccess('Excel export uses the full list. CSV supports filtered export.');
        window.location.href = '/api/artists/export/download?format=xlsx';
    }
}

function downloadCSV(artists, filename) {
    var headers = ['Name', 'Nickname', 'Revenue Type', 'Artist Split %', 'Company Split %', 'Bank Fee %', 'Referrals', 'Notes'];
    var esc = function(v) {
        if (v === null || v === undefined) return '';
        var s = String(v);
        return (s.indexOf(',') > -1 || s.indexOf('"') > -1 || s.indexOf('\n') > -1) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    var rows = [headers.join(',')];
    artists.forEach(function(a) {
        var refs = (a.referrals || []).map(function(r) { return 'L' + r.level + ': ' + r.referrer_name + ' (' + r.commission_pct + '%)'; }).join('; ');
        rows.push([
            esc(a.name), esc(a.nickname), esc(a.revenue_type),
            esc(a.artist_split_pct), esc(a.company_split_pct), esc(a.bank_fee_pct),
            esc(refs), esc(a.notes)
        ].join(','));
    });
    var blob = new Blob(['\ufeff' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url; link.download = filename;
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
    setTimeout(function() { URL.revokeObjectURL(url); }, 100);
    App.showSuccess('Exported ' + artists.length + ' artist' + (artists.length === 1 ? '' : 's'));
}

function printArtists() {
    var rows = artistsTable.rows({ search: 'applied' }).data();
    var filtered = [];
    for (var i = 0; i < rows.length; i++) {
        var nameCell = typeof rows[i][0] === 'string' ? rows[i][0] : rows[i][0];
        filtered.push(String(nameCell).replace(/<[^>]+>/g, '').trim());
    }
    var artists = artistsData.filter(function(a) { return filtered.indexOf(a.name) !== -1; });

    var html = '<html><head><title>Artists — Deng Parez</title>' +
        '<style>' +
        'body{font-family:Arial,sans-serif;padding:20px;color:#1f2937;}' +
        'h1{color:#3b82f6;border-bottom:2px solid #3b82f6;padding-bottom:8px;}' +
        'table{width:100%;border-collapse:collapse;margin-top:15px;font-size:12px;}' +
        'th{background:#3b82f6;color:#fff;padding:8px;text-align:left;}' +
        'td{border:1px solid #e5e7eb;padding:6px 8px;}' +
        'tr:nth-child(even){background:#f9fafb;}' +
        '.meta{color:#6b7280;font-size:12px;margin-bottom:10px;}' +
        '@media print { body { padding: 0; } }' +
        '</style></head><body>' +
        '<h1>Artists — Deng Parez Monetary System</h1>' +
        '<div class="meta">Generated: ' + new Date().toLocaleString() + ' · Total: ' + artists.length + ' artist' + (artists.length === 1 ? '' : 's') + '</div>' +
        '<table><thead><tr>' +
        '<th>Name</th><th>Nickname</th><th>Type</th><th>Artist %</th><th>Company %</th><th>Bank Fee %</th><th>Referrals</th>' +
        '</tr></thead><tbody>';
    artists.forEach(function(a) {
        var refs = (a.referrals || []).map(function(r) { return 'L' + r.level + ': ' + r.referrer_name + ' (' + r.commission_pct + '%)'; }).join('<br>');
        html += '<tr><td>' + escapeHtml(a.name) + '</td>' +
            '<td>' + escapeHtml(a.nickname || '-') + '</td>' +
            '<td>' + a.revenue_type + '</td>' +
            '<td>' + a.artist_split_pct + '%</td>' +
            '<td>' + a.company_split_pct + '%</td>' +
            '<td>' + a.bank_fee_pct + '%</td>' +
            '<td>' + (refs || '-') + '</td></tr>';
    });
    html += '</tbody></table></body></html>';

    var w = window.open('', '_blank');
    w.document.write(html); w.document.close();
    setTimeout(function() { w.focus(); w.print(); }, 250);
}

function resetForm() {
    $('#modal-title').text('Add Artist');
    $('#artist-id').val('');
    $('#artist-form')[0].reset();
    $('#artist-split').val(60);
    $('#company-split').val(40);
    $('#bank-fee').val(2.5);
    $('#referral-rows').empty();
}

function addReferralRow(name, pct) {
    var idx = $('#referral-rows .referral-row').length + 1;
    var html = '<div class="referral-row row mb-2">' +
        '<div class="col-1 d-flex align-items-center"><strong>L' + idx + '</strong></div>' +
        '<div class="col-5"><input type="text" class="form-control ref-name" placeholder="Referrer name" value="' + (name || '') + '"></div>' +
        '<div class="col-4"><div class="input-group"><input type="number" class="form-control ref-pct" placeholder="%" value="' + (pct || '') + '" min="0" max="100" step="0.01"><div class="input-group-append"><span class="input-group-text">%</span></div></div></div>' +
        '<div class="col-2"><button type="button" class="btn btn-sm btn-outline-danger" onclick="$(this).closest(\'.referral-row\').remove()"><i class="ti-close"></i></button></div>' +
        '</div>';
    $('#referral-rows').append(html);
}

function editArtist(id) {
    var artist = artistsData.find(function(a) { return a.id === id; });
    if (!artist) return;
    $('#modal-title').text('Edit Artist');
    $('#artist-id').val(artist.id);
    $('#artist-name').val(artist.name);
    $('#artist-nickname').val(artist.nickname);
    $('#artist-revenue-type').val(artist.revenue_type);
    $('#artist-split').val(artist.artist_split_pct);
    $('#company-split').val(artist.company_split_pct);
    $('#bank-fee').val(artist.bank_fee_pct);
    $('#artist-notes').val(artist.notes);
    $('#referral-rows').empty();
    if (artist.referrals) {
        artist.referrals.forEach(function(r) {
            addReferralRow(r.referrer_name, r.commission_pct);
        });
    }
    $('#artistModal').modal('show');
}

function saveArtist() {
    var id = $('#artist-id').val();
    var referrals = [];
    $('#referral-rows .referral-row').each(function(i) {
        var name = $(this).find('.ref-name').val().trim();
        var pct = parseFloat($(this).find('.ref-pct').val());
        if (name && pct) {
            referrals.push({ level: i + 1, referrer_name: name, commission_pct: pct });
        }
    });

    var data = {
        name: $('#artist-name').val().trim(),
        nickname: $('#artist-nickname').val().trim() || null,
        revenue_type: $('#artist-revenue-type').val(),
        artist_split_pct: parseFloat($('#artist-split').val()),
        company_split_pct: parseFloat($('#company-split').val()),
        bank_fee_pct: parseFloat($('#bank-fee').val()),
        notes: $('#artist-notes').val().trim() || null,
        referrals: referrals
    };

    if (!data.name) { App.showError('Name is required'); return; }

    var method = id ? 'PUT' : 'POST';
    var url = id ? '/api/artists/' + id : '/api/artists';

    App.api(method, url, data).done(function() {
        $('#artistModal').modal('hide');
        App.showSuccess('Artist ' + (id ? 'updated' : 'created') + ' successfully');
        loadArtists();
    });
}

function confirmDelete(id, name) {
    $('#delete-name').text(name);
    $('#confirm-delete-btn').off('click').on('click', function() {
        App.api('DELETE', '/api/artists/' + id).done(function() {
            $('#deleteModal').modal('hide');
            App.showSuccess('Artist deleted');
            loadArtists();
        });
    });
    $('#deleteModal').modal('show');
}

function importArtists() {
    var file = $('#import-file')[0].files[0];
    if (!file) { App.showError('Please select a file'); return; }
    var formData = new FormData();
    formData.append('file', file);
    $.ajax({
        url: '/api/import/artists',
        method: 'POST',
        data: formData,
        processData: false,
        contentType: false,
        success: function(res) {
            $('#importModal').modal('hide');
            App.showSuccess('Imported ' + res.imported + ' of ' + res.total + ' artists');
            loadArtists();
        },
        error: function(xhr) {
            App.showError(xhr.responseJSON ? xhr.responseJSON.error : 'Import failed');
        }
    });
}

// Auto-sync splits
$('#artist-split').on('input', function() {
    $('#company-split').val((100 - parseFloat($(this).val() || 0)).toFixed(2));
});
$('#company-split').on('input', function() {
    $('#artist-split').val((100 - parseFloat($(this).val() || 0)).toFixed(2));
});

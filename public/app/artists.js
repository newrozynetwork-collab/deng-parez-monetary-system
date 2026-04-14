var artistsData = [];

App.init(function() {
    loadArtists();
});

function loadArtists() {
    App.api('GET', '/api/artists').done(function(artists) {
        artistsData = artists;
        var tbody = $('#artists-body');
        tbody.empty();
        artists.forEach(function(a) {
            var refCount = a.referrals ? a.referrals.length : 0;
            var refText = refCount > 0 ? refCount + ' level(s)' : '<span class="text-muted">None</span>';
            tbody.append(
                '<tr>' +
                '<td><a href="/artists/' + a.id + '" class="text-primary font-weight-medium">' + a.name + '</a></td>' +
                '<td>' + (a.nickname || '-') + '</td>' +
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
        $('#artists-table').DataTable({ responsive: true, order: [[0, 'asc']] });
        feather.replace();
    });
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

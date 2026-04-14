var artistsList = [];
var calcTimeout;

App.init(function() {
    loadArtistsDropdown();
});

function loadArtistsDropdown() {
    App.api('GET', '/api/artists').done(function(artists) {
        artistsList = artists;
        var sel = $('#rev-artist');
        artists.forEach(function(a) {
            sel.append('<option value="' + a.id + '">' + a.name + (a.nickname ? ' (' + a.nickname + ')' : '') + '</option>');
        });
    });
}

$('#rev-artist').on('change', function() {
    var id = parseInt($(this).val());
    var artist = artistsList.find(function(a) { return a.id === id; });
    if (artist) {
        $('#rev-source').val(artist.revenue_type);
        // Show artist info
        var refs = (artist.referrals || []).map(function(r) {
            return '<span class="badge badge-primary mr-1">L' + r.level + ': ' + r.referrer_name + ' (' + r.commission_pct + '%)</span>';
        }).join('') || '<span class="text-muted">No referrals</span>';
        $('#artist-info-content').html(
            '<p><strong>Split:</strong> Artist ' + artist.artist_split_pct + '% / Company ' + artist.company_split_pct + '%</p>' +
            '<p><strong>Bank Fee:</strong> ' + artist.bank_fee_pct + '%</p>' +
            '<p><strong>Referrals:</strong> ' + refs + '</p>'
        );
        $('#artist-info-card').removeClass('d-none');
        updatePreview();
    } else {
        $('#artist-info-card').addClass('d-none');
    }
});

$('#rev-amount').on('input', function() {
    clearTimeout(calcTimeout);
    calcTimeout = setTimeout(updatePreview, 300);
});

function updatePreview() {
    var artistId = $('#rev-artist').val();
    var amount = parseFloat($('#rev-amount').val());
    if (!artistId || !amount || amount <= 0) {
        $('#preview-empty').removeClass('d-none');
        $('#preview-content').addClass('d-none');
        return;
    }

    App.api('POST', '/api/revenue/calculate', { artist_id: parseInt(artistId), amount: amount })
        .done(function(calc) {
            $('#preview-empty').addClass('d-none');
            $('#preview-content').removeClass('d-none');

            $('#calc-gross').text(App.formatCurrency(calc.grossRevenue));
            $('#calc-fee-pct').text(calc.bankFeePct);
            $('#calc-fee').text('-' + App.formatCurrency(calc.bankFee));
            $('#calc-net').text(App.formatCurrency(calc.netRevenue));
            $('#calc-artist-pct').text(calc.artistSplitPct);
            $('#calc-artist').text(App.formatCurrency(calc.artistShare));
            $('#calc-company-pct').text(calc.companySplitPct);
            $('#calc-company-gross').text(App.formatCurrency(calc.companyGross));

            var refsHtml = '';
            if (calc.referralBreakdown.length === 0) {
                refsHtml = '<div class="text-muted small">No referrals configured</div>';
            } else {
                calc.referralBreakdown.forEach(function(r) {
                    refsHtml += '<div class="referral-item d-flex justify-content-between">' +
                        '<span>L' + r.level + ': ' + r.referrerName + ' (' + r.commissionPct + '% of company)</span>' +
                        '<span class="text-warning font-weight-medium">' + App.formatCurrency(r.amount) + '</span>' +
                        '</div>';
                });
                refsHtml += '<div class="calc-row mt-2"><span class="calc-label">Total Referrals</span><span class="calc-value text-warning">' + App.formatCurrency(calc.totalReferrals) + '</span></div>';
            }
            $('#calc-referrals').html(refsHtml);
            $('#calc-company-net').text(App.formatCurrency(calc.companyNet));
        });
}

$('#revenue-form').on('submit', function(e) {
    e.preventDefault();
    var data = {
        artist_id: parseInt($('#rev-artist').val()),
        amount: parseFloat($('#rev-amount').val()),
        source: $('#rev-source').val(),
        period_start: $('#rev-start').val() || null,
        period_end: $('#rev-end').val() || null,
        notes: $('#rev-notes').val().trim() || null
    };
    if (!data.artist_id || !data.amount) {
        App.showError('Artist and amount are required');
        return;
    }
    var btn = $('#save-btn');
    btn.prop('disabled', true).text('Saving...');
    App.api('POST', '/api/revenue', data).done(function() {
        App.showSuccess('Revenue entry saved successfully');
        setTimeout(function() { window.location.href = '/revenue'; }, 1000);
    }).always(function() {
        btn.prop('disabled', false).html('<i data-feather="save" class="feather-icon mr-1"></i> Save Revenue Entry');
        feather.replace();
    });
});

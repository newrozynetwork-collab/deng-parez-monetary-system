var trendChart, sourceChart;

App.init(function() {
    initDateRange();
    loadDashboard();
});

function initDateRange() {
    $('#date-range').daterangepicker({
        autoUpdateInput: false,
        locale: { cancelLabel: 'Clear', format: 'YYYY-MM-DD' },
        ranges: {
            'Today': [moment(), moment()],
            'This Week': [moment().startOf('week'), moment().endOf('week')],
            'This Month': [moment().startOf('month'), moment().endOf('month')],
            'Last Month': [moment().subtract(1, 'month').startOf('month'), moment().subtract(1, 'month').endOf('month')],
            'This Year': [moment().startOf('year'), moment().endOf('year')],
            'All Time': [moment('2020-01-01'), moment()]
        }
    });
    $('#date-range').on('apply.daterangepicker', function(ev, picker) {
        $(this).val(picker.startDate.format('YYYY-MM-DD') + ' - ' + picker.endDate.format('YYYY-MM-DD'));
        loadDashboard(picker.startDate.format('YYYY-MM-DD'), picker.endDate.format('YYYY-MM-DD'));
    });
    $('#date-range').on('cancel.daterangepicker', function() {
        $(this).val('');
        loadDashboard();
    });
}

function loadDashboard(start, end) {
    var params = {};
    if (start) params.start = start;
    if (end) params.end = end;

    App.api('GET', '/api/reports/dashboard', params).done(function(data) {
        $('#stat-revenue').text(App.formatCurrency(data.totalRevenue));
        $('#stat-payouts').text(App.formatCurrency(data.totalPayouts));
        $('#stat-profit').text(App.formatCurrency(data.netProfit));
        $('#stat-artists').text(data.activeArtists);
        $('#stat-artist-payouts').text(App.formatCurrency(data.totalArtistPayouts));
        $('#stat-referral-payouts').text(App.formatCurrency(data.totalReferralPayouts));
        $('#stat-bank-fees').text(App.formatCurrency(data.totalBankFees));

        renderTrendChart(data.monthlyRevenue);
        renderSourceChart(data.revenueBySource);
    });
}

function renderTrendChart(monthlyData) {
    var ctx = document.getElementById('revenue-trend-chart').getContext('2d');
    if (trendChart) trendChart.destroy();

    trendChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: monthlyData.map(function(m) { return m.month; }),
            datasets: [{
                label: 'Revenue',
                data: monthlyData.map(function(m) { return m.total; }),
                borderColor: '#3b82f6',
                backgroundColor: 'rgba(59, 130, 246, 0.1)',
                fill: true,
                tension: 0.4,
                pointBackgroundColor: '#3b82f6'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: { beginAtZero: true, ticks: { callback: function(v) { return '$' + v; } } }
            }
        }
    });
}

function renderSourceChart(sourceData) {
    var ctx = document.getElementById('revenue-source-chart').getContext('2d');
    if (sourceChart) sourceChart.destroy();

    var colors = { youtube: '#ef4444', platform: '#14b8a6', both: '#3b82f6' };
    sourceChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: sourceData.map(function(s) { return App.sourceLabel(s.source); }),
            datasets: [{
                data: sourceData.map(function(s) { return s.total; }),
                backgroundColor: sourceData.map(function(s) { return colors[s.source] || '#6c757d'; })
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom' }
            }
        }
    });
}

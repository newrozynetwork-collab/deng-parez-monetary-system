// Common utilities for Deng Parez Monetary System
var App = {
    user: null,

    init: function(callback) {
        $.ajax({
            url: '/api/auth/me',
            method: 'GET',
            success: function(user) {
                App.user = user;
                $('#user-name').text(user.name);
                $('#user-role').text(user.role);
                if (user.role !== 'admin') {
                    $('.admin-only').hide();
                }
                if (callback) callback(user);
            },
            error: function() {
                window.location.href = '/login';
            }
        });
    },

    logout: function() {
        $.post('/api/auth/logout', function() {
            window.location.href = '/login';
        });
    },

    formatCurrency: function(amount) {
        return '$' + parseFloat(amount || 0).toFixed(2).replace(/\d(?=(\d{3})+\.)/g, '$&,');
    },

    formatNumber: function(num) {
        return parseFloat(num || 0).toLocaleString();
    },

    formatDate: function(dateStr) {
        if (!dateStr) return '-';
        var d = new Date(dateStr);
        return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    },

    showSuccess: function(msg) {
        var toast = $('<div class="alert alert-success alert-dismissible fade show position-fixed" style="top:20px;right:20px;z-index:9999;min-width:300px;"><button type="button" class="close" data-dismiss="alert">&times;</button>' + msg + '</div>');
        $('body').append(toast);
        setTimeout(function() { toast.alert('close'); }, 3000);
    },

    showError: function(msg) {
        var toast = $('<div class="alert alert-danger alert-dismissible fade show position-fixed" style="top:20px;right:20px;z-index:9999;min-width:300px;"><button type="button" class="close" data-dismiss="alert">&times;</button>' + msg + '</div>');
        $('body').append(toast);
        setTimeout(function() { toast.alert('close'); }, 5000);
    },

    api: function(method, url, data) {
        var opts = {
            url: url,
            method: method,
            contentType: 'application/json'
        };
        if (data && method !== 'GET') opts.data = JSON.stringify(data);
        if (data && method === 'GET') opts.data = data;
        return $.ajax(opts).fail(function(xhr) {
            if (xhr.status === 401) window.location.href = '/login';
            else App.showError(xhr.responseJSON ? xhr.responseJSON.error : 'Request failed');
        });
    },

    sourceLabel: function(source) {
        var labels = { youtube: 'YouTube', platform: 'Platform', both: 'Both' };
        return labels[source] || source;
    },

    sourceBadge: function(source) {
        var colors = { youtube: 'danger', platform: 'info', both: 'primary' };
        return '<span class="badge badge-' + (colors[source] || 'secondary') + '">' + App.sourceLabel(source) + '</span>';
    }
};

$(document).on('click', '#logout-btn', function(e) {
    e.preventDefault();
    App.logout();
});

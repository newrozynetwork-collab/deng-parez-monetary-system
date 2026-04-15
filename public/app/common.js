// Common utilities for Deng Parez Monetary System
var App = {
    user: null,

    applyTheme: function(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        try { localStorage.setItem('dp-theme', theme); } catch(e) {}
    },

    toggleTheme: function() {
        var current = document.documentElement.getAttribute('data-theme') || 'light';
        App.applyTheme(current === 'dark' ? 'light' : 'dark');
    },

    initTheme: function() {
        var saved = 'light';
        try { saved = localStorage.getItem('dp-theme') || 'light'; } catch(e) {}
        App.applyTheme(saved);
    },

    injectThemeToggle: function() {
        if (document.getElementById('theme-toggle-btn')) return;
        var btn = '<button class="theme-toggle" id="theme-toggle-btn" title="Toggle dark mode" type="button">' +
            '<svg class="theme-icon-dark" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>' +
            '<svg class="theme-icon-light" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>' +
            '</button>';
        // Insert before the user dropdown in the topbar
        var target = $('.navbar-nav.float-right').first();
        if (target.length) {
            target.prepend('<li class="nav-item d-flex align-items-center">' + btn + '</li>');
        }
        $('#theme-toggle-btn').on('click', function(e) {
            e.preventDefault();
            App.toggleTheme();
        });
    },

    init: function(callback) {
        App.initTheme();
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
                App.injectThemeToggle();
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

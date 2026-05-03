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
    getTitleTrophies,
    getUserTrophiesEarnedForTitle,
    getProfileFromUserName,
    getUserTrophyProfileSummary,
    makeUniversalSearch
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

// NEW: Helper function to ensure we always have a valid token for PSN routes
async function getValidPsnToken(username) {
    const user = await SuperUser.findOne({ username });
    if (!user || !user.psnNpsso) throw new Error("PSN Account not linked.");
    return await getPsnToken(user.psnNpsso);
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

// --- UPDATED: STEAM ACHIEVEMENTS WITH PRIVACY FLAG ---
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
        let isPrivate = false; // FLAG to tell frontend if API blocked us
        
        try {
            const userRes = await axios.get(userStatsUrl);
            userUnlocked = userRes.data?.playerstats?.achievements || [];
        } catch (e) {
            // Steam returns a 400 error if the user has NEVER played the game OR if it is private
            isPrivate = true;
            console.log(`Steam API rejected stats for user ${steamid} on game ${appid}. (Private or never played)`);
        }

        // 3. Combine the data so we know the names, icons, AND unlock status
        const finalAchievements = availableAchievements.map(schemaAch => {
            const userAch = userUnlocked.find(u => u.apiname === schemaAch.name);
            
            return {
                userId: steamid, // Ensure we tag this trophy to the specific user
                platform: 'Steam',
                platformGameId: appid,
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
                { 
                    userId: steamid, 
                    platformGameId: appid, 
                    platform: 'Steam',      
                    apiname: ach.apiname 
                },
                ach, // Save the whole compiled object
                { upsert: true }
            );
        });
        await Promise.all(achievementPromises);

        // 5. Send data back to the frontend (including the privacy flag)
        res.json({ message: "Success", isPrivate: isPrivate, achievements: finalAchievements });

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
        // UPDATED: Query using platformGameId instead of appid to match the new schema
        const achievements = await Achievement.find({ userId: steamid, platformGameId: appid });
        res.json(achievements);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// --- PLAYSTATION ROUTES ---
// ==========================================

// 1. LINK PSN ACCOUNT (Updated to fetch real onlineId)
app.post('/api/auth/link-psn', async (req, res) => {
    try {
        const { username, npsso } = req.body;
        
        // 1. Test the npsso and get user info
        const token = await getPsnToken(npsso);
        
        // 2. NEW: Use the "me" shortcut to ask Sony for our real username
        const { getProfileFromUserName } = require("psn-api"); 
        const myProfile = await getProfileFromUserName(token, "me");
        const realOnlineId = myProfile.profile.onlineId;
        
        // 3. Update user in DB with both IDs
        const updatedUser = await SuperUser.findOneAndUpdate(
            { username: username },
            { 
                psnNpsso: npsso,
                psnAccountId: token.accountId, 
                linkedPsnId: realOnlineId // We now save the real PSN Username!
            },
            { new: true }
        );

        res.json({ 
            message: "PlayStation account linked successfully!", 
            accountId: token.accountId,
            onlineId: realOnlineId 
        });
    } catch (error) {
        res.status(500).json({ message: "Invalid npsso token or Sony error." });
    }
});

// --- UPDATED: SYNC PSN GAMES WITH TARGET ID ---
app.post('/api/psn/sync/:username/:targetAccountId', async (req, res) => {
    try {
        const { username, targetAccountId } = req.params; 
        
        const user = await SuperUser.findOne({ username: username });
        if (!user.psnNpsso) return res.status(400).json({ message: "PSN not linked." });

        const token = await getPsnToken(user.psnNpsso);
        
        // Use targetAccountId so we can sync friends
        const response = await getUserTitles(token, targetAccountId);
        const titles = response.trophyTitles || [];

        // Save PSN titles to the Game collection under the TARGET'S ID
        const gamePromises = titles.map(title => {
            return Game.findOneAndUpdate(
                { userId: targetAccountId, platform: 'PSN', platformGameId: title.npCommunicationId },
                { 
                    name: title.trophyTitleName, 
                    img_icon_url: title.trophyTitleIconUrl,
                    playtime_forever: 0 
                },
                { upsert: true }
            );
        });
        await Promise.all(gamePromises);

        res.json({ message: `Success! Synced ${titles.length} PlayStation games.` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- UPDATED: GET PSN TROPHIES WITH TARGET ID ---
app.get('/api/psn/achievements/:username/:targetAccountId/:npId', async (req, res) => {
    const { username, targetAccountId, npId } = req.params;

    try {
        const user = await SuperUser.findOne({ username });
        const token = await getPsnToken(user.psnNpsso);

        // 1. Get Trophy Definitions
        const trophyRes = await getTitleTrophies(token, npId, "all", { npServiceName: "trophy" });
        const trophyDefinitions = trophyRes.trophies || [];

        // 2. Get User Progress
        let userProgress = [];
        try {
            // Ask Sony for the specific target user's progress
            const progressRes = await getUserTrophiesEarnedForTitle(token, targetAccountId, npId, "all", { npServiceName: "trophy" });
            userProgress = progressRes.trophies || [];
        } catch (e) {
            console.log(`User ${targetAccountId} progress private or not started for game ${npId}.`);
        }

        // 3. Combine them
        const finalTrophies = trophyDefinitions.map(def => {
            const prog = userProgress.find(p => p.trophyId === def.trophyId);
            return {
                userId: targetAccountId, // Save it under the target user's ID
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

        if (finalTrophies.length === 0) return res.json({ error: "No trophies found." });

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
        console.error("PSN TROPHY ERROR:", error);
        res.status(500).json({ error: error.message });
    }
});

// 4. GET PSN PROFILE INFO (Avatar, Name)
app.get('/api/psn/profile/:username/:psnId', async (req, res) => {
    const { username, psnId } = req.params;
    try {
        const token = await getValidPsnToken(username);
        const profileResponse = await getProfileFromUserName(token, psnId);
        const profile = profileResponse.profile;

        res.json({
            onlineId: profile.onlineId,
            accountId: profile.accountId,
            avatar: profile.avatarUrls[0]?.avatarUrl || "",
            aboutMe: profile.aboutMe || "No bio provided."
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 5. GET PSN TROPHY SUMMARY (Level, Progress, Gold/Silver counts)
app.get('/api/psn/trophy-summary/:username/:accountId', async (req, res) => {
    const { username, accountId } = req.params;
    try {
        const token = await getValidPsnToken(username);
        const summary = await getUserTrophyProfileSummary(token, accountId);
        
        res.json({
            level: summary.trophyLevel,
            progress: summary.progress,
            tier: summary.tier, 
            earned: summary.earnedTrophies 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 6. SEARCH FOR PSN PLAYERS
app.get('/api/search/psn/:username/:query', async (req, res) => {
    const { username, query } = req.params;
    try {
        const token = await getValidPsnToken(username);
        const searchRes = await makeUniversalSearch(token, query, "SocialAllAccounts");
        const matches = searchRes.domainResponses[0]?.results || [];
        
        const formattedResults = matches.map(match => ({
            onlineId: match.socialMetadata.onlineId,
            accountId: match.socialMetadata.accountId,
            avatar: match.socialMetadata.avatarUrl
        }));

        res.json(formattedResults);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


// ==========================================
// --- XBOX (OpenXBL) ROUTES ---
// ==========================================

const getXboxHeaders = () => {
    const key = process.env.XBOX_API_KEY;
    if (!key) console.error("WARNING: XBOX_API_KEY is not set in environment variables!");
    return {
        'X-Authorization': key,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
    };
};

// NEW: Bulletproof helper to extract the player array from OpenXBL, regardless of what they name it
function extractXboxPlayers(data) {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.people)) return data.people;
    if (Array.isArray(data.users)) return data.users;
    if (Array.isArray(data.profileUsers)) return data.profileUsers;
    
    // If they changed the name again, just find whatever array is in the object
    for (let key in data) {
        if (Array.isArray(data[key])) return data[key];
    }
    return [];
}

// 1. LINK XBOX ACCOUNT
app.post('/api/auth/link-xbox', async (req, res) => {
    try {
        const { username, gamertag } = req.body;
        const encodedQuery = encodeURIComponent(gamertag);
        const searchRes = await axios.get(`https://xbl.io/api/v2/search/${encodedQuery}`, { headers: getXboxHeaders() });
        
        const matches = extractXboxPlayers(searchRes.data);
        
        if (matches.length === 0) {
            return res.status(404).json({ message: "Gamertag not found." });
        }

        const xuid = matches[0].xuid;
        const realGamertag = matches[0].uniqueModernGamertag || matches[0].gamertag;

        const updatedUser = await SuperUser.findOneAndUpdate(
            { username: username },
            { linkedXboxXuid: xuid, xboxGamertag: realGamertag },
            { new: true }
        );

        res.json({ message: "Xbox account linked successfully!", xuid: xuid, gamertag: realGamertag });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Failed to link Xbox account." });
    }
});

// 2. SEARCH XBOX PLAYERS
app.get('/api/search/xbox/:query', async (req, res) => {
    try {
        const { query } = req.params;
        const encodedQuery = encodeURIComponent(query);
        const searchRes = await axios.get(`https://xbl.io/api/v2/search/${encodedQuery}`, { headers: getXboxHeaders() });
        
        // Use our new smart extractor
        const matches = extractXboxPlayers(searchRes.data);
        
        const formattedResults = matches.map(p => ({
            xuid: p.xuid,
            gamertag: p.uniqueModernGamertag || p.gamertag,
            avatar: p.displayPicRaw
        }));

        res.json(formattedResults);
    } catch (error) {
        console.error("XBOX SEARCH ERROR:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "Failed to search Xbox network." });
    }
});

// 3. GET XBOX PROFILE INFO
app.get('/api/xbox/profile/:xuid', async (req, res) => {
    try {
        const { xuid } = req.params;
        const profileRes = await axios.get(`https://xbl.io/api/v2/player/summary/${xuid}`, { headers: getXboxHeaders() });
        
        // Use our new smart extractor here too!
        const matches = extractXboxPlayers(profileRes.data);
        if (matches.length === 0) return res.status(404).json({ error: "Profile data missing." });
        
        const p = matches[0];

        res.json({
            gamertag: p.uniqueModernGamertag || p.gamertag,
            xuid: p.xuid,
            avatar: p.displayPicRaw,
            gamerscore: p.gamerScore,
            presence: p.presenceState
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 4. SYNC XBOX GAMES
app.post('/api/xbox/sync/:xuid', async (req, res) => {
    try {
        const { xuid } = req.params;
        const url = `https://xbl.io/api/v2/achievements/player/${xuid}`;
        
        // GET request
        const gamesRes = await axios.get(url, { headers: getXboxHeaders() });
        const titles = gamesRes.data.titles || [];

        const gamePromises = titles.map(title => {
            return Game.findOneAndUpdate(
                { userId: xuid, platform: 'Xbox', platformGameId: title.titleId.toString() },
                { 
                    name: title.name, 
                    img_icon_url: title.displayImage, 
                    playtime_forever: 0 
                },
                { upsert: true }
            );
        });
        await Promise.all(gamePromises);

        res.json({ message: `Success! Synced ${titles.length} Xbox games.` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 5. GET XBOX ACHIEVEMENTS
app.get('/api/xbox/achievements/:xuid/:titleId', async (req, res) => {
    try {
        const { xuid, titleId } = req.params;
        const url = `https://xbl.io/api/v2/achievements/player/${xuid}/title/${titleId}`;
        
        // GET request
        const achRes = await axios.get(url, { headers: getXboxHeaders() });
        const achievements = achRes.data.achievements || [];

        if (achievements.length === 0) return res.json({ error: "No achievements found." });

        const finalAchievements = achievements.map(ach => {
            const isUnlocked = ach.progressState === "Achieved";
            return {
                userId: xuid,
                platform: 'Xbox',
                platformGameId: titleId,
                apiname: ach.id.toString(),
                displayName: ach.name,
                description: ach.lockedDescription || ach.description,
                iconUrl: ach.mediaAssets[0]?.url || "",
                achieved: isUnlocked ? 1 : 0,
                unlocktime: isUnlocked && ach.progression?.timeUnlocked ? new Date(ach.progression.timeUnlocked).getTime() / 1000 : 0
            };
        });

        const achievementPromises = finalAchievements.map(t => {
            return Achievement.findOneAndUpdate(
                { userId: t.userId, platform: 'Xbox', apiname: t.apiname, platformGameId: titleId },
                t,
                { upsert: true }
            );
        });
        await Promise.all(achievementPromises);

        res.json(finalAchievements);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


// ==========================================
// --- AUTHENTICATION ROUTES ---
// ==========================================

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
            linkedSteamId: user.linkedSteamId,
            psnAccountId: user.psnAccountId // UPDATED: Also return PSN ID so auto-login works
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

// ==========================================
// --- DASHBOARD & SOCIAL ROUTES ---
// ==========================================

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
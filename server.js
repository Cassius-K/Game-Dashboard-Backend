require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const User = require('./models/User');
const Game = require('./models/Game');
const Achievement = require('./models/Achievement');
const jwt = require('jsonwebtoken');
const SuperUser = require('./models/SuperUser');

const app = express();
app.use(cors());
app.use(express.json());

// Basic route to test if the server is running
app.get('/api/status', (req, res) => {
    res.json({ message: "Giga Dashboard Backend is live and ready!" });
});

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("Connected to MongoDB Atlas"))
    .catch((err) => console.log("Failed to connect to MongoDB", err));
	
const axios = require('axios');

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
        // 1. Sync Profile Info
        const profileUrl = `http://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${apiKey}&steamids=${steamid}`;
        const profileRes = await axios.get(profileUrl);
        
        if (!profileRes.data?.response?.players?.length) {
            return res.status(404).json({ message: "Steam profile not found or is completely private." });
        }

        const p = profileRes.data.response.players[0];

        await User.findOneAndUpdate(
            { steamId: steamid },
            { personaname: p.personaname, profileurl: p.profileurl, avatar: p.avatarfull, lastUpdated: Date.now() },
            { upsert: true }
        );

        // 2. Sync Owned Games
		const gamesUrl = `http://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${apiKey}&steamid=${steamid}&include_appinfo=true&include_played_free_games=true`;
        const gamesRes = await axios.get(gamesUrl);
        
        // FIX: Use optional chaining and default to an empty array
        const games = gamesRes.data?.response?.games || [];

        if (games.length > 0) {
            const gamePromises = games.map(game => {
                return Game.findOneAndUpdate(
                    { appid: game.appid },
                    { name: game.name, img_icon_url: game.img_icon_url, playtime_forever: game.playtime_forever },
                    { upsert: true }
                );
            });
            await Promise.all(gamePromises);
            res.json({ message: `Success! Synced ${games.length} games for ${p.personaname}` });
        } else {
            // If the code reaches here, the profile was found but the games list was hidden/empty
            res.json({ message: `Profile found, but no games were visible. Check your Steam Privacy settings (Game Details must be Public).` });
        }

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
            // Steam returns a 400 error if the user has NEVER played the game, 
            // so we just catch it and leave userUnlocked empty.
            console.log(`User hasn't played game ${appid} or stats are private.`);
        }

        // 3. Combine the data so we know the names, icons, AND unlock status
        const finalAchievements = availableAchievements.map(schemaAch => {
            // Find if the user unlocked this specific achievement
            const userAch = userUnlocked.find(u => u.apiname === schemaAch.name);
            
            return {
                apiname: schemaAch.name,
                displayName: schemaAch.displayName,
                description: schemaAch.description,
                iconUrl: userAch?.achieved ? schemaAch.icon : schemaAch.icongray, // Use colored icon if unlocked
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

// Get all games for a user from MongoDB (so we don't have to hit Steam API again)
app.get('/api/games/:steamid', async (req, res) => {
    try {
        // Find the user first
        const user = await User.findOne({ steamId: req.params.steamid });
        if (!user) return res.status(404).json({ message: "User not found in database. Try syncing first." });

        // Since we didn't strictly link Game to User in the schema earlier, 
        // for now we will just return all games (we can fix the schema later to be more robust)
        // UPDATED: Added .sort({ name: 1 }) to sort results alphabetically (A-Z)
        const games = await Game.find({}).sort({ name: 1 }); 
        
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

// --- AUTHENTICATION ROUTES ---

// 1. Sign Up
app.post('/api/auth/signup', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ message: "Username and password required" });

        const newUser = new GigaUser({ username, password });
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

        // Create a token (Use your own secret key from .env later, but this works for now)
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
        
        // Find the user and update their linkedSteamId
        const updatedUser = await SuperUser.findOneAndUpdate(
            { username: username },
            { linkedSteamId: steamId },
            { new: true } // Returns the updated document
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

        // 1. Count ALL achievements synced for this user
        const totalAchievements = await Achievement.countDocuments({ userId: steamid });

        // 2. Count ONLY the unlocked achievements for this user
        const unlockedAchievements = await Achievement.countDocuments({ userId: steamid, achieved: 1 });

        // 3. Calculate percentage
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
        // 1. Find all users who have actually linked a Steam account
        const users = await SuperUser.find({ linkedSteamId: { $ne: null } }, 'username linkedSteamId');

        // 2. Count unlocked achievements for each user
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

        // 3. Sort the array from highest to lowest
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
        // 1. Sanitize the query for MongoDB Regex (prevents crashes from special characters like ' or [)
        const safeQuery = query.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');

        // 2. Search local MongoDB (Increased limit to 15 to show multiple users with same name)
        const localMatches = await User.find({
            personaname: { $regex: safeQuery, $options: 'i' } 
        }).limit(15);

        // 3. Try to resolve the query as a Steam Vanity URL
        let vanityMatch = null;
        try {
            // Encode the URI component to safely handle apostrophes in the URL request
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
            console.log("Vanity URL lookup failed or not found.");
        }

        // 4. Combine results and remove duplicates
        let results = [...localMatches];
        
        // If we found a Steam Vanity match, and it's NOT already in our local results, add it to the top
        if (vanityMatch) {
            const alreadyInLocal = results.some(r => r.steamId === vanityMatch.steamid);
            if (!alreadyInLocal) {
                results.unshift({
                    steamId: vanityMatch.steamid,
                    personaname: vanityMatch.personaname,
                    avatar: vanityMatch.avatar,
                    isNew: true // Flag to show it's fresh from Steam
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

        // Use the MongoDB Aggregation Pipeline to do all the work in the database
        const result = await Game.aggregate([
            // Stage 1: Match all games that belong to the user (this is a simplified match for now)
            // A more advanced version would link Games directly to a User ID
            // For now, we assume all synced games are for the active user
            
            // Stage 2: Group all matched documents and sum their 'playtime_forever' field
            {
                $group: {
                    _id: null, // Group all documents into a single result
                    totalMinutes: { $sum: '$playtime_forever' }
                }
            }
        ]);

        if (result.length > 0) {
            const totalHours = Math.round(result[0].totalMinutes / 60);
            res.json({ totalHours });
        } else {
            res.json({ totalHours: 0 }); // If no games are found
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

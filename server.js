require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const User = require('./models/User');
const Game = require('./models/Game');
const Achievement = require('./models/Achievement');

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
        // 1. Sync Profile
        const profileUrl = `http://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${apiKey}&steamids=${steamid}`;
        const profileRes = await axios.get(profileUrl);
        const p = profileRes.data.response.players[0];

        await User.findOneAndUpdate(
            { steamId: steamid },
            { personaname: p.personaname, profileurl: p.profileurl, avatar: p.avatarfull, lastUpdated: Date.now() },
            { upsert: true } // "Upsert" means: Update if exists, Insert if it doesn't
        );

        // 2. Sync Owned Games
        const gamesUrl = `http://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${apiKey}&steamid=${steamid}&include_appinfo=true`;
        const gamesRes = await axios.get(gamesUrl);
        const games = gamesRes.data.response.games;

        // Save games to the database
        const gamePromises = games.map(game => {
            return Game.findOneAndUpdate(
                { appid: game.appid },
                { name: game.name, img_icon_url: game.img_icon_url, playtime_forever: game.playtime_forever },
                { upsert: true }
            );
        });
        await Promise.all(gamePromises);

        res.json({ success: true, message: `Synced ${games.length} games for ${p.personaname}` });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

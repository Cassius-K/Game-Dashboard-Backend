require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

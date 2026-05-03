const mongoose = require('mongoose');
const AchievementSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    platform: String,
    platformGameId: String,
    apiname: String,
    displayName: String,
    description: String,
    iconUrl: String,
    achieved: Number,
    unlocktime: Number
	value: String
});
module.exports = mongoose.model('Achievement', AchievementSchema);
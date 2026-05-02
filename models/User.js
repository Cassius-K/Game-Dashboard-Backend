const mongoose = require('mongoose');
const UserSchema = new mongoose.Schema({
    steamId: { type: String, unique: true },
    personaname: String,
    profileurl: String,
    avatar: String,
    lastUpdated: { type: Date, default: Date.now }
});
module.exports = mongoose.model('User', UserSchema);
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const SuperUserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    
    // Steam Data
    linkedSteamId: { type: String, default: null },

    // Xbox Data (NEW)
    linkedXboxXuid: { type: String, default: null }, // Xbox uses a 'XUID' (User ID)
    xboxGamertag: { type: String, default: null },

    // PlayStation Data (NEW)
    linkedPsnId: { type: String, default: null }, // Their online name (e.g. 'PlayerOne')
    psnAccountId: { type: String, default: null }, // Sony's internal ID
    psnNpsso: { type: String, default: null } // The token used to refresh access
});

// Hash password before saving
SuperUserSchema.pre('save', async function() {
    if (!this.isModified('password')) return;
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
});

// Helper method to check password
SuperUserSchema.methods.comparePassword = async function(candidatePassword) {
    return await bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('SuperUser', SuperUserSchema);
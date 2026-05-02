const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const SuperUserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    linkedSteamId: { type: String, default: null } // We will link their Steam ID here later!
});

// Hash password before saving
SuperUserSchema.pre('save', async function(next) {
    if (!this.isModified('password')) return next();
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
});

// Helper method to check password
SuperUserSchema.methods.comparePassword = async function(candidatePassword) {
    return await bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('SuperUser', SuperUserSchema);
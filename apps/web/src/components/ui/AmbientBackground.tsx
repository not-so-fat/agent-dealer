/** Fixed ambient blur orbs — cyan/blue/pink wash behind glass panels. */
export default function AmbientBackground() {
  return (
    <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden" aria-hidden>
      <div className="absolute top-16 left-12">
        <div className="ambient-orb ambient-orb-a w-[26rem] h-[26rem] rounded-full bg-cyan-500/10 blur-3xl" />
      </div>
      <div className="absolute bottom-20 right-12">
        <div className="ambient-orb ambient-orb-b w-[26rem] h-[26rem] rounded-full bg-pink-500/10 blur-3xl" />
      </div>
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
        <div className="ambient-orb ambient-orb-c w-[22rem] h-[22rem] rounded-full bg-blue-500/[0.07] blur-3xl" />
      </div>
    </div>
  );
}

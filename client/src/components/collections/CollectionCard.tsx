import React from 'react';
import { Link } from 'react-router-dom';
import { FolderKanban, Users, Globe, Lock, Film, CheckCircle2 } from 'lucide-react';
import { Collection } from '../../types';
import { Badge } from '../common/Badge';

interface CollectionCardProps {
  collection: Collection;
  isSharedWithMe?: boolean;
}

export const CollectionCard: React.FC<CollectionCardProps> = ({
  collection,
  isSharedWithMe = false,
}) => {
  const movieCount = collection._count?.movies || 0;
  const isPublic = collection.visibility === 'PUBLIC_LINK';

  return (
    <Link
      to={`/collections/${collection.id}`}
      className="group relative flex flex-col justify-between p-5 rounded-2xl bg-[#121622] border border-zinc-800/80 hover:border-zinc-700/80 transition-all duration-200 hover:shadow-xl hover:shadow-black/60 overflow-hidden"
    >
      <div className="space-y-3">
        {/* Header badges */}
        <div className="flex items-center justify-between gap-2">
          <div className="w-10 h-10 rounded-xl bg-zinc-800/80 border border-zinc-700/60 flex items-center justify-center text-red-500 group-hover:scale-105 transition-transform">
            <FolderKanban className="w-5 h-5" />
          </div>

          <div className="flex items-center gap-1.5">
            {isSharedWithMe ? (
              <Badge variant="indigo" size="sm">
                <Users className="w-3 h-3" />
                Shared with me
              </Badge>
            ) : isPublic ? (
              <Badge variant="purple" size="sm">
                <Globe className="w-3 h-3" />
                Public Link
              </Badge>
            ) : (
              <Badge variant="zinc" size="sm">
                <Lock className="w-3 h-3" />
                Private
              </Badge>
            )}
          </div>
        </div>

        {/* Title & Description */}
        <div>
          <h3 className="text-base font-bold text-slate-100 group-hover:text-red-400 transition-colors line-clamp-1">
            {collection.title}
          </h3>
          {collection.description ? (
            <p className="text-xs text-zinc-400 line-clamp-2 mt-1 leading-relaxed">
              {collection.description}
            </p>
          ) : (
            <p className="text-xs text-zinc-500 italic mt-1">No description provided</p>
          )}
        </div>
      </div>

      {/* Footer Info */}
      <div className="pt-4 mt-4 border-t border-zinc-800/80 flex items-center justify-between text-xs text-zinc-400">
        <div className="flex items-center gap-1.5 font-medium">
          <Film className="w-3.5 h-3.5 text-zinc-500" />
          <span>{movieCount} {movieCount === 1 ? 'Movie' : 'Movies'}</span>
        </div>

        {isSharedWithMe && (
          <span className="text-[11px] text-zinc-500">
            by @{collection.owner?.username}
          </span>
        )}
      </div>
    </Link>
  );
};
